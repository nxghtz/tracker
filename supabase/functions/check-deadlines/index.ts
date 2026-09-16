// =====================================================================
// supabase/functions/check-deadlines/index.ts
//
// เรียกโดย pg_cron ทุก 1 นาที — Ladder แจ้งเตือนเดียว ใช้เหมือนกันทุกงาน:
//
//   30 วัน -> 14 วัน -> 7 วัน -> 3 วัน (ครั้งละ 1 ครั้ง)
//   -> ทุก 1 ชม. ตั้งแต่ 24 ชม.ก่อนกำหนด ถึง 4 ชม. (24,23,...,4 = 21 ครั้ง)
//   -> ทุก 30 นาที ตั้งแต่ 3 ชม.ก่อนกำหนด ถึง 30 นาที (180,150,...,30 = 6 ครั้ง)
//   -> เลยกำหนด (1 ครั้ง จบ)
//
// รวมทั้งหมด 32 ขั้น เก็บความคืบหน้าไว้ใน tasks.notify_rank (1..32) กันส่งซ้ำ
// ขั้นเดิม — ไล่ขึ้นทีละขั้นเท่านั้น ถ้าข้ามหลายขั้นมาพร้อมกัน (เช่น cron หยุดไปพัก
// หนึ่ง) จะแจ้งแค่ขั้นล่าสุดที่ควรจะเป็นขั้นเดียว ไม่ยิงย้อนหลังทุกขั้นที่พลาดไป
//
// งานที่ปิด reminder_enabled (toggle "เปิด/ปิดการแจ้งเตือนของงานนี้" ในหน้าเว็บ)
// จะถูกข้ามไปทั้งหมดทุกขั้น เหมือนตัวเลือก "ไม่แจ้งเตือน" เดิม
//
// โหมด "งดแจ้งเตือนกลางคืน" (profiles.quiet_hours_enabled, ตั้งได้ต่อผู้ใช้จากหน้า
// เว็บ) — ถ้าเปิดไว้และถึงเวลาที่ควรแจ้งเตือนพอดีตอน 23:00–06:00 (เวลาไทย, ตายตัว
// เท่ากันทุกคน) จะไม่ส่งเลย ถือว่าพลาดจุดนั้นไปแล้วไปจับจุดถัดไปตามปกติ ไม่ใช่การ
// เลื่อนไปส่งตอนเช้าแทน
//
// Deploy: supabase functions deploy check-deadlines --no-verify-jwt
// Secrets ที่ต้องตั้งไว้แล้ว: LINE_CHANNEL_ACCESS_TOKEN, CRON_SECRET
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type StageKind = "days" | "hourly" | "halfhour" | "overdue";
interface Stage {
  minutesBefore: number;
  kind: StageKind;
  label: string;
}

function buildStages(): Stage[] {
  const stages: Stage[] = [];

  for (const days of [30, 14, 7, 3]) {
    stages.push({ minutesBefore: days * 24 * 60, kind: "days", label: `${days} วัน` });
  }

  for (let h = 24; h >= 4; h--) {
    stages.push({ minutesBefore: h * 60, kind: "hourly", label: `${h} ชม.` });
  }

  for (let m = 180; m >= 30; m -= 30) {
    stages.push({ minutesBefore: m, kind: "halfhour", label: `${m} นาที` });
  }

  stages.push({ minutesBefore: 0, kind: "overdue", label: "เลยกำหนด" });

  return stages;
}

const STAGES = buildStages();

const QUIET_HOURS_START = 23;
const QUIET_HOURS_END = 6;

function isWithinQuietHours(now: Date): boolean {
  const bangkokHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Bangkok", hour: "2-digit", hour12: false }).format(now)
  );
  return bangkokHour >= QUIET_HOURS_START || bangkokHour < QUIET_HOURS_END;
}

function computeTargetRank(remainingMinutes: number): number {
  let target = 0;
  for (let i = 0; i < STAGES.length; i++) {
    if (STAGES[i].minutesBefore >= remainingMinutes) {
      target = i + 1;
    } else {
      break;
    }
  }
  return target;
}

function formatBangkokDeadline(value: string): string {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(value));
}

function formatRemaining(deadline: Date, now: Date): string {
  const totalMinutes = Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} ชั่วโมง ${minutes} นาที` : `${minutes} นาที`;
}

function getMessageForStage(stage: Stage, task: any): string {
  const subject = task.subject_name;
  const name = task.task_name;
  const teacherLine = task.teacher_name ? `\n👨‍🏫 อาจารย์: ${task.teacher_name}` : "";
  const deadline = new Date(task.deadline);
  const now = new Date();
  const deadlineLine = `\n📍 กำหนดส่ง: ${formatBangkokDeadline(task.deadline)} น. (เวลาไทย)`;
  const remainingLine = deadline > now ? `\n⏳ เหลือเวลา: ${formatRemaining(deadline, now)}` : "";

  if (stage.kind === "overdue") {
    return `🔴 เลยกำหนดส่งงานแล้ว\n\n📚 วิชา: ${subject}\n📝 งาน: ${name}${teacherLine}${deadlineLine}\n\nกรุณาติดต่ออาจารย์ผู้สอนหากยังไม่ได้ส่งงาน`;
  }

  if (stage.kind === "days") {
    return `📅 แจ้งเตือนล่วงหน้า\n\n📚 วิชา: ${subject}\n📝 งาน: ${name}${teacherLine}${deadlineLine}${remainingLine}\n\nเหลืออีก ${stage.label} เริ่มเตรียมตัวได้แล้วนะครับ`;
  }

  if (stage.kind === "hourly") {
    return `⏰ ใกล้ถึงกำหนดส่งงานแล้ว\n\n📚 วิชา: ${subject}\n📝 งาน: ${name}${teacherLine}${deadlineLine}${remainingLine}`;
  }

  return `🔥 ด่วนมาก! เหลือเวลาไม่ถึง ${Math.ceil(stage.minutesBefore / 60)} ชม.\n\n📚 วิชา: ${subject}\n📝 งาน: ${name}${teacherLine}${deadlineLine}${remainingLine}\n\nรีบตรวจสอบและส่งงานด่วนเลยครับ`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  const CRON_SECRET = Deno.env.get("CRON_SECRET");
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();

  const lookback = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const lookahead = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);

  const { data: tasks, error } = await sbAdmin
    .from("tasks")
    .select("id, task_name, subject_name, teacher_name, deadline, notify_rank, reminder_enabled, profiles(line_token, first_name, quiet_hours_enabled)")
    .in("status", ["pending", "in_progress"])
    .gte("deadline", lookback.toISOString())
    .lte("deadline", lookahead.toISOString());

  if (error) {
    console.error("Query error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  let sentCount = 0;
  let skippedQuietHours = 0;
  let checkedCount = 0;
  const updates: { id: string; notify_rank: number }[] = [];

  for (const task of tasks ?? []) {
    checkedCount++;

    if (task.reminder_enabled === false) continue;

    const deadline = new Date(task.deadline);
    const remainingMinutes = (deadline.getTime() - now.getTime()) / 60_000;
    const targetRank = computeTargetRank(remainingMinutes);
    const currentRank = task.notify_rank || 0;

    if (targetRank <= currentRank) continue;

    const stage = STAGES[targetRank - 1];
    const lineToken = (task as any).profiles?.line_token;
    const quietHoursEnabled = (task as any).profiles?.quiet_hours_enabled === true;
    const skipDueToQuietHours = quietHoursEnabled && isWithinQuietHours(now);

    if (skipDueToQuietHours) {
      skippedQuietHours++;
    } else if (lineToken) {
      const message = getMessageForStage(stage, task);
      const ok = await pushMessage(lineToken, message);
      if (ok) sentCount++;
    }

    updates.push({ id: task.id, notify_rank: targetRank });
  }

  for (const u of updates) {
    await sbAdmin
      .from("tasks")
      .update({ notify_rank: u.notify_rank, notified_at: now.toISOString() })
      .eq("id", u.id);
  }

  return new Response(
    JSON.stringify({
      checked: checkedCount,
      stage_updates: updates.length,
      notifications_sent: sentCount,
      skipped_quiet_hours: skippedQuietHours
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});

async function pushMessage(lineUserId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: "text", text }]
      })
    });
    if (!res.ok) {
      console.error("LINE push failed:", await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("LINE push error:", err);
    return false;
  }
}
