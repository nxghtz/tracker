// =====================================================================
// supabase/functions/username-login/index.ts
//
// Deploy: supabase functions deploy username-login --no-verify-jwt
//
// ก่อน deploy ต้องตั้ง secret นี้ (คั่นด้วย , ถ้ามีหลายโดเมน เช่น dev/prod):
//   supabase secrets set ALLOWED_ORIGINS=https://your-site.com,https://your-site.pages.dev
// ถ้าไม่ตั้งไว้ ฟังก์ชันจะ "เปิดกว้างเหมือนเดิม" (Access-Control-Allow-Origin: *)
// เพื่อไม่ให้เว็บพังทันทีหลัง deploy — แต่ควรตั้งค่านี้โดยเร็วที่สุด
//
// error ที่ "คาดไว้แล้ว" ตามปกติของการล็อกอิน (username/password ผิด, rate
// limit) ตอบกลับด้วย HTTP 200 พร้อม { error: "..." } ใน body แทนที่จะเป็น
// 401/429 เพราะ sb.functions.invoke() ฝั่ง client จะไม่อ่าน JSON body ให้เลย
// เมื่อ status ไม่ใช่ 2xx — เหลือแค่ error ที่ไม่คาดคิดจริงๆ (เช่น DB/เครือข่าย
// ล่มกลางทาง) เท่านั้นที่เป็น 500
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------
// Rate limiting: กันบรูทฟอร์ซรหัสผ่าน / กันสแกนหา username ที่มีอยู่จริง
// จำกัด 2 ชั้น: ต่อ username เดียว (เข้มกว่า) และต่อ IP โดยรวม (หลวมกว่า
// กันโดนบล็อกทั้งโรงเรียนที่ใช้ NAT วง IP เดียวกัน)
// ---------------------------------------------------------------------
const USERNAME_MAX_ATTEMPTS = 5;
const IP_MAX_ATTEMPTS = 30;
const WINDOW_MINUTES = 15;

async function isRateLimited(identifier: string, maxAttempts: number): Promise<boolean> {
  const { count, error } = await admin
    .from("login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("identifier", identifier)
    .gte("attempted_at", new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString());

  if (error) {
    console.error("Rate limit check failed:", error.message);
    return false; // เช็คไม่ได้ ปล่อยผ่านดีกว่าทำให้ login พังทั้งระบบ
  }
  return (count ?? 0) >= maxAttempts;
}

async function recordAttempt(identifier: string) {
  await admin.from("login_attempts").insert({ identifier });
}

function corsHeadersFor(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const allowOrigin =
    ALLOWED_ORIGINS.length === 0
      ? "*"
      : ALLOWED_ORIGINS.includes(origin)
        ? origin
        : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin"
  };
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405, cors);

  const clientIp = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();

  try {
    const { username, password } = await req.json();
    if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
      return response({ error: "Invalid login credentials" }, 200, cors);
    }
    const normalizedUsername = username.trim().toLowerCase();

    // เช็ค rate limit ก่อนแตะฐานข้อมูล/ระบบยืนยันตัวตนใดๆ
    if (await isRateLimited(`ip:${clientIp}`, IP_MAX_ATTEMPTS) ||
        await isRateLimited(`user:${normalizedUsername}`, USERNAME_MAX_ATTEMPTS)) {
      return response({ error: "พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ภายหลัง" }, 200, cors);
    }
    await recordAttempt(`ip:${clientIp}`);
    await recordAttempt(`user:${normalizedUsername}`);

    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .ilike("username", username.trim())
      .maybeSingle();

    if (!profile) {
      // หน่วงเวลาเทียมเพื่อลด timing side-channel ที่ทำให้แยกออกว่า username
      // นี้มีอยู่จริงหรือไม่ (เทียบกับ path ด้านล่างที่ต้องรอ getUserById + token exchange)
      await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 150));
      return response({ error: "Invalid login credentials" }, 200, cors);
    }

    const { data: userData, error: userError } = await admin.auth.admin.getUserById(profile.id);
    const email = userData.user?.email;
    if (userError || !email) return response({ error: "Invalid login credentials" }, 200, cors);

    const loginResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password })
    });
    if (!loginResponse.ok) return response({ error: "Invalid login credentials" }, 200, cors);

    const session = await loginResponse.json();
    return response(session, 200, cors);
  } catch (err) {
    // เหลือแค่ error ที่ไม่คาดคิดจริงๆ (เช่น DB/เครือข่ายล่มกลางทาง) เท่านั้น
    // ที่เป็น 500 — ฝั่ง client มี fallback message รองรับ status นี้อยู่แล้ว
    console.error("username-login unexpected error:", err);
    return response({ error: "Internal server error" }, 500, cors);
  }
});

function response(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}
