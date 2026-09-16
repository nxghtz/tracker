// =====================================================================
// supabase/functions/line-webhook/index.ts
//
// รับ Webhook events จาก LINE Messaging API
// ใช้สำหรับ "Account Linking": ผู้ใช้พิมพ์รหัส 6 หลักส่งมาในแชท LINE OA
// -> ฟังก์ชันนี้จะจับคู่รหัสกับ profiles แล้วบันทึก LINE User ID ลง line_token
//
// Deploy: supabase functions deploy line-webhook --no-verify-jwt
// (ต้องใช้ --no-verify-jwt เพราะ LINE เรียก endpoint นี้โดยไม่มี Supabase JWT)
//
// ต้องตั้งค่า Secrets ก่อน deploy:
//   supabase secrets set LINE_CHANNEL_SECRET=xxxxx
//   supabase secrets set LINE_CHANNEL_ACCESS_TOKEN=xxxxx
//   (SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY มีให้อัตโนมัติอยู่แล้วใน Edge Function)
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LINE_CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET")!;
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();

  const signature = req.headers.get("x-line-signature") ?? "";
  const isValid = await verifySignature(rawBody, signature, LINE_CHANNEL_SECRET);
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const body = JSON.parse(rawBody);
  const events = body.events ?? [];

  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("Error handling event:", err);
    }
  }

  return new Response("OK", { status: 200 });
});

async function handleEvent(event: any) {
  const lineUserId = event.source?.userId;
  if (!lineUserId) return;

  if (event.type === "follow") {
    await replyMessage(event.replyToken,
      "ยินดีต้อนรับ 👋\nพิมพ์ \"รหัสเชื่อมต่อ 6 หลัก\" ที่ได้จากหน้าเว็บระบบส่งงาน เพื่อเชื่อมบัญชี LINE ของคุณกับระบบ\n\nหลังจากเชื่อมต่อแล้ว พิมพ์คำว่า \"งาน รายการงาน เช็คงาน ดูงาน งานของฉัน\" ได้ทุกเมื่อ เพื่อดูรายการงานที่ยังไม่ได้ส่ง"
    );
    return;
  }

  if (event.type === "message" && event.message?.type === "text") {
    const text = (event.message.text || "").trim();

    if (/^\d{6}$/.test(text)) {
      const { data: profile, error } = await sbAdmin
        .from("profiles")
        .select("id, first_name, line_link_code_expires_at")
        .eq("line_link_code", text)
        .maybeSingle();

      if (error || !profile) {
        await replyMessage(event.replyToken, "❌ ไม่พบรหัสนี้ในระบบ กรุณาตรวจสอบรหัสอีกครั้ง");
        return;
      }

      const expired = new Date(profile.line_link_code_expires_at) < new Date();
      if (expired) {
        await replyMessage(event.replyToken, "❌ รหัสหมดอายุแล้ว กรุณากดขอรหัสใหม่ในหน้าเว็บอีกครั้ง");
        return;
      }

      await sbAdmin
        .from("profiles")
        .update({
          line_token: lineUserId,
          line_link_code: null,
          line_link_code_expires_at: null
        })
        .eq("id", profile.id);

      await replyMessage(event.replyToken,
        `✅ เชื่อมต่อบัญชีสำเร็จ!\nคุณจะได้รับการแจ้งเตือนเมื่องานใกล้ถึงกำหนดส่งทาง LINE นี้`
      );
      return;
    }

    const taskListCommands = ["งาน", "รายการงาน", "เช็คงาน", "ดูงาน", "งานของฉัน"];
    if (taskListCommands.includes(text)) {
      await replyTaskList(event.replyToken, lineUserId);
      return;
    }
  }
}

async function replyTaskList(replyToken: string, lineUserId: string) {
  const { data: profile, error: profileError } = await sbAdmin
    .from("profiles")
    .select("id, first_name")
    .eq("line_token", lineUserId)
    .maybeSingle();

  if (profileError || !profile) {
    await replyMessage(replyToken, "ยังไม่ได้เชื่อมต่อบัญชีนี้กับระบบ กรุณาพิมพ์รหัสเชื่อมต่อ 6 หลักจากหน้าเว็บก่อนครับ");
    return;
  }

  const { data: tasks, error: tasksError } = await sbAdmin
    .from("tasks")
    .select("task_name, subject_name, deadline, status")
    .eq("user_id", profile.id)
    .in("status", ["pending"])
    .order("deadline", { ascending: true })
    .limit(10);

  if (tasksError) {
    await replyMessage(replyToken, "เกิดข้อผิดพลาดในการดึงข้อมูล ลองใหม่อีกครั้งครับ");
    return;
  }

  if (!tasks || tasks.length === 0) {
    await replyMessage(replyToken, `📋 ${profile.first_name} ไม่มีงานค้างอยู่เลยตอนนี้ เยี่ยมมาก! 🎉`);
    return;
  }

  const now = new Date();
  const lines = tasks.map((t, i) => {
    const deadline = new Date(t.deadline);
    const isLate = deadline < now;
    const dateStr = deadline.toLocaleString("th-TH", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      timeZone: "Asia/Bangkok"
    });
    const flag = isLate ? "🔴 เลยกำหนด" : "⏳";
    return `${i + 1}. ${t.task_name} (${t.subject_name})\n   ${flag} ${dateStr}`;
  });

  const message = `📋 รายการงานของ ${profile.first_name}\n\n${lines.join("\n\n")}`;
  await replyMessage(replyToken, message);
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(
    Array.from(new Uint8Array(sigBuffer))
      .map((byte) => String.fromCharCode(byte))
      .join("")
  );
  return expected === signature;
}

async function replyMessage(replyToken: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });
}
