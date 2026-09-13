/* =====================================================================
   app.js
   Logic หลักของหน้า index.html — เชื่อมต่อ Supabase ทั้งหมด
   ===================================================================== */

/* ---------------------------------------------------------------------
   CONFIG — ใส่ค่าเดียวกับที่ใช้ใน auth.html
   --------------------------------------------------------------------- */
const SUPABASE_URL = "https://tdceqvzottwnvdxgztol.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkY2VxdnpvdHR3bnZkeGd6dG9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MDIzMzYsImV4cCI6MjA5ODQ3ODMzNn0.psPQn1E-FpLJEKl0figueqTO_3Z4AS6glsT78KYxwQw";

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BUCKET_NAME = "task-attachments";
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// LINE OA ID (ไม่ต้องใส่ @ นำหน้า) — ใช้สร้าง QR Code แอดเพื่อนอัตโนมัติ
// หาได้จาก LINE Official Account Manager (เช่น @768mvsci -> ใส่ "768mvsci")
const LINE_OA_ID = "768mvsci";

// เก็บ state ในหน่วยความจำระหว่างใช้งานหน้านี้
let currentUser = null;      // auth user object
let currentProfile = null;   // แถวจาก public.profiles
let allTasks = [];           // งานทั้งหมดที่ query มาได้ (ตาม RLS)
let currentFilter = "all";
let currentSearch = "";
let currentSort = "deadline-asc";
let selectedFile = null;
let countdownTimer = null;
let iosPickerCallback = null;

const TASK_PAGE_SIZE = 10;  // จำนวนงานต่อหน้า
let taskPage = 1;           // หน้าปัจจุบันของรายการงาน (หลังกรอง/ค้นหา)


/* =====================================================================
   1. AUTH GUARD — เช็ค session ก่อนอนุญาตให้ใช้งานหน้านี้
   ===================================================================== */
(async function init() {
  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    window.location.href = "auth.html";
    return;
  }
  currentUser = session.user;

  // ถ้ามีการ logout จากแท็บอื่น ให้เด้งออกด้วย
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      window.location.href = "auth.html";
    }
  });

  await loadProfile();
  await loadTasks();
  setupRealtime();
  setupEventListeners();
  renderToday();

  // อัปเดต countdown ทุก 30 วินาที
  countdownTimer = setInterval(renderTasks, 30000);
})();


/* =====================================================================
   2. โหลดโปรไฟล์ผู้ใช้ มาแสดงที่ header
   ===================================================================== */
async function loadProfile() {
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (error) {
    console.error("โหลดโปรไฟล์ไม่สำเร็จ:", error.message);
    return;
  }

  currentProfile = data;

  const fullName = `${data.first_name} ${data.last_name}`.trim() || currentUser.email;
  const initials = ((data.first_name?.[0] || "") + (data.last_name?.[0] || "")).toUpperCase()
                    || currentUser.email[0].toUpperCase();

  document.getElementById("profileName").textContent = fullName;
  document.getElementById("avatarInitials").textContent = initials || "--";
  document.getElementById("profileRole").textContent = data.username ? `@${data.username}` : "";

  // อัปเดตสถานะปุ่มเชื่อมต่อ LINE (เขียว = เชื่อมต่อแล้ว, เทา = ยังไม่เชื่อมต่อ)
  const lineBtn = document.getElementById("lineConnectBtn");
  if (data.line_token) {
    lineBtn.style.background = "var(--success-soft)";
    lineBtn.style.color = "var(--success)";
    lineBtn.style.borderColor = "var(--success)";
    lineBtn.title = "เชื่อมต่อ LINE แล้ว (คลิกเพื่อยกเลิก)";
  } else {
    lineBtn.style.background = "var(--bg)";
    lineBtn.style.color = "var(--text-muted)";
    lineBtn.style.borderColor = "var(--border)";
    lineBtn.title = "เชื่อมต่อ LINE เพื่อรับแจ้งเตือน";
  }

  if (!data.username) promptUsername();
}

async function promptUsername() {
  const result = await Swal.fire({
    title: "ตั้งชื่อผู้ใช้งาน",
    text: "ใช้สำหรับเข้าสู่ระบบแทนอีเมลได้",
    input: "text",
    inputPlaceholder: "เช่น mind_2026",
    confirmButtonText: "บันทึก",
    confirmButtonColor: "#5b6ee1",
    showCancelButton: true,
    cancelButtonText: "ไว้ภายหลัง",
    inputValidator: (value) => {
      if (!/^[A-Za-z0-9_-]{3,30}$/.test(value.trim())) return "ใช้ตัวอักษรอังกฤษ ตัวเลข _ หรือ - จำนวน 3–30 ตัว";
    }
  });
  if (!result.isConfirmed) return;

  const { error } = await sb.from("profiles")
    .update({ username: result.value.trim().toLowerCase() })
    .eq("id", currentUser.id);
  if (error) {
    // 23505 = unique_violation จริงๆ (ชื่อซ้ำ) — เคสอื่น (เช่น network error)
    // ไม่ควรบอกผู้ใช้ว่า "ชื่อซ้ำ" เพราะไม่จริงและวนกลับมาถามซ้ำโดยไม่มีประโยชน์
    const isDuplicate = error.code === "23505";
    Swal.fire({
      icon: "error",
      title: "บันทึกชื่อผู้ใช้งานไม่สำเร็จ",
      text: isDuplicate ? "ชื่อนี้ถูกใช้แล้ว ลองชื่ออื่นอีกครั้ง" : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง",
      confirmButtonColor: "#5b6ee1"
    }).then(() => { if (isDuplicate) promptUsername(); });
    return;
  }
  await loadProfile();
}

/* =====================================================================
   3. โหลดรายการงาน
   ---------------------------------------------------------------------
   หมายเหตุ: ไม่ต้องกรอง user_id เองใน query — RLS policy ที่ตั้งไว้ใน
   supabase_setup.sql จะกรองให้อัตโนมัติอยู่แล้ว (แต่ละคนเห็นเฉพาะงานของตัวเอง)
   ===================================================================== */
async function loadTasks() {
  const { data, error } = await sb
    .from("tasks")
    .select("*, profiles(first_name, last_name)")
    .order("deadline", { ascending: true });

  if (error) {
    console.error("โหลดงานไม่สำเร็จ:", error.message);
    Swal.fire({ icon: "error", title: "โหลดข้อมูลไม่สำเร็จ", text: error.message, confirmButtonColor: "#5b6ee1" });
    return;
  }

  allTasks = data;
  renderStats();
  renderTasks();
}


/* =====================================================================
   4. RENDER: สถิติ (การ์ดตัวเลขด้านบน)
   ===================================================================== */
function renderStats() {
  const now = new Date();
  const total = allTasks.length;
  // ใช้ getEffectiveStatus() ให้เหมือนกันทุกหมวด (แทนที่จะใช้ status ดิบสำหรับ pending
  // แต่ใช้ effective status สำหรับ overdue) เพื่อไม่ให้งานที่เลยกำหนดแล้วแต่ยังไม่ได้
  // เปลี่ยน status ใน DB ถูกนับซ้ำทั้งใน "รอดำเนินการ" และ "เลยกำหนด" พร้อมกัน
  const pending = allTasks.filter(t => ["pending", "in_progress"].includes(getEffectiveStatus(t, now))).length;
  const submitted = allTasks.filter(t => t.status === "submitted").length;
  const overdue = allTasks.filter(t => getEffectiveStatus(t, now) === "late").length;

  document.getElementById("statTotal").textContent = total;
  document.getElementById("statPending").textContent = pending;
  document.getElementById("statSubmitted").textContent = submitted;
  document.getElementById("statOverdue").textContent = overdue;
}


/* =====================================================================
   5. RENDER: การ์ดรายการงาน (ตาม filter ที่เลือก)
   ===================================================================== */
function renderTasks() {
  const container = document.getElementById("taskCards");
  const emptyState = document.getElementById("emptyState");

  // อัปเดตสถานะ "late" อัตโนมัติถ้าเลยเดดไลน์แล้วแต่ยังไม่ส่ง (เฉพาะการแสดงผล
  // ฝั่ง client — ค่าจริงใน DB จะถูกอัปเดตโดย pg_cron ในขั้นตอนถัดไป)
  const now = new Date();

  let filtered = allTasks.filter(t => {
    const effectiveStatus = getEffectiveStatus(t, now);
    if (currentFilter === "all") return true;
    if (currentFilter === "urgent") return effectiveStatus !== "submitted" && effectiveStatus !== "cancelled" && new Date(t.deadline) - now <= 24 * 60 * 60 * 1000;
    if (currentFilter === "pending") return ["pending", "in_progress", "late"].includes(effectiveStatus);
    if (currentFilter === "submitted") return effectiveStatus === "submitted";
    return true;
  }).filter(t => {
    const needle = currentSearch.toLocaleLowerCase("th-TH");
    return !needle || [t.task_name, t.subject_name, t.description].some(value =>
      String(value || "").toLocaleLowerCase("th-TH").includes(needle)
    );
  });

  const statusRank = { late: 0, pending: 1, in_progress: 2, submitted: 3, cancelled: 4 };
  filtered.sort((a, b) => {
    if (currentSort === "deadline-desc") return new Date(b.deadline) - new Date(a.deadline);
    if (currentSort === "status") return statusRank[getEffectiveStatus(a, now)] - statusRank[getEffectiveStatus(b, now)];
    if (currentSort === "created-desc") return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    return new Date(a.deadline) - new Date(b.deadline);
  });

  const paginationBar = document.getElementById("taskPagination");
  const pageIndicator = document.getElementById("pageIndicator");
  const btnPrevPage = document.getElementById("btnPrevPage");
  const btnNextPage = document.getElementById("btnNextPage");

  if (filtered.length === 0) {
    container.innerHTML = "";
    emptyState.style.display = "block";
    paginationBar.hidden = true;
    return;
  }
  emptyState.style.display = "none";

  const totalPages = Math.max(1, Math.ceil(filtered.length / TASK_PAGE_SIZE));
  if (taskPage > totalPages) taskPage = totalPages; // เผื่อกรอง/ค้นหาแล้วจำนวนหน้าลดลง

  const start = (taskPage - 1) * TASK_PAGE_SIZE;
  const visible = filtered.slice(start, start + TASK_PAGE_SIZE);
  container.innerHTML = visible.map(t => renderCard(t, now)).join("");

  // แสดงแถบเปลี่ยนหน้าเฉพาะเมื่อมีมากกว่า 1 หน้า
  if (totalPages > 1) {
    pageIndicator.textContent = `หน้า ${taskPage} / ${totalPages}`;
    btnPrevPage.disabled = taskPage <= 1;
    btnNextPage.disabled = taskPage >= totalPages;
    paginationBar.hidden = false;
  } else {
    paginationBar.hidden = true;
  }
}

function getEffectiveStatus(task, now) {
  if (["submitted", "cancelled"].includes(task.status)) return task.status;
  const deadline = new Date(task.deadline);
  if (deadline < now) return "late";
  return task.status === "in_progress" ? "in_progress" : "pending";
}

function renderCard(task, now) {
  const status = getEffectiveStatus(task, now);
  const countdownHtml = renderCountdown(task, status, now);

  return `
    <div class="card status-${status}" data-id="${task.id}">
      <div class="status-bar"></div>
      <div class="body">
        <div class="subject">${escapeHtml(task.subject_name)}</div>
        <div class="task-name">${escapeHtml(task.task_name)}</div>
        <div class="desc">${escapeHtml(task.description || "ไม่มีรายละเอียดเพิ่มเติม")}</div>
        ${task.file_url ? `<div class="attachment-name"><i class="fa-solid fa-paperclip"></i> ${escapeHtml(task.file_url.split("/").pop())}</div>` : ""}
      </div>
      <div class="meta">
        <select class="status-select badge ${status}" onchange="updateTaskStatus('${task.id}', this.value)" aria-label="สถานะของ ${escapeAttr(task.task_name)}">
          <option value="pending" ${task.status === "pending" ? "selected" : ""}>ยังไม่เริ่ม</option>
          <option value="in_progress" ${task.status === "in_progress" ? "selected" : ""}>กำลังทำ</option>
          <option value="submitted" ${task.status === "submitted" ? "selected" : ""}>ส่งแล้ว</option>
          <option value="cancelled" ${task.status === "cancelled" ? "selected" : ""}>ยกเลิก</option>
        </select>
        ${countdownHtml}
      </div>
      <div class="actions">
        ${task.file_url ? `<div class="icon-btn" onclick="downloadFile('${task.id}')" title="ดาวน์โหลดไฟล์แนบ"><i class="fa-solid fa-paperclip"></i></div>` : ""}
        <div class="icon-btn" onclick="openEditModal('${task.id}')" title="แก้ไข"><i class="fa-solid fa-pen"></i></div>
        <div class="icon-btn" onclick="deleteTask('${task.id}')" title="ลบ"><i class="fa-solid fa-trash"></i></div>
      </div>
    </div>
  `;
}

function renderCountdown(task, status, now) {
  if (status === "submitted") {
    return `<span class="countdown"><i class="fa-solid fa-check"></i> ส่งแล้ว</span>`;
  }
  if (status === "cancelled") {
    return `<span class="countdown"><i class="fa-solid fa-ban"></i> ยกเลิกแล้ว</span>`;
  }
  const deadline = new Date(task.deadline);
  const diffMs = deadline - now;
  const isUrgent = diffMs < 3 * 60 * 60 * 1000; // เหลือน้อยกว่า 3 ชม. หรือเลยกำหนด

  if (diffMs < 0) {
    const overdue = formatDuration(-diffMs);
    return `<span class="countdown urgent"><i class="fa-regular fa-clock"></i> เลยมา ${overdue}</span>`;
  }
  const remaining = formatDuration(diffMs);
  return `<span class="countdown ${isUrgent ? "urgent" : ""}"><i class="fa-regular fa-clock"></i> เหลือ ${remaining}</span>`;
}

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days} วัน ${hours} ชม.`;
  if (hours > 0) return `${hours} ชม. ${minutes} นาที`;
  return `${minutes} นาที`;
}

function getBangkokParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour, minute: parts.minute };
}

function openIosDateTimePicker(initialValue, onConfirm) {
  const now = getBangkokParts(new Date());
  const [date = now.date, time = `${now.hour}:${now.minute}`] = (initialValue || "").split("T");
  const [hour = now.hour, minute = now.minute] = time.split(":");

  // ปัดนาทีให้ลงตัวที่ 5 นาที (ตามช่วงของ pickerMinuteWheel) โดยคำนวณเป็น "นาทีรวม
  // ของวัน" ก่อน แล้วค่อยแยกกลับเป็นชั่วโมง/นาที — ถ้าปัดแยกทีละนาที (เช่น 58 -> 60 % 60
  // = 0) จะได้ "00" แต่ชั่วโมงไม่ถูกบวกตาม ทำให้ค่าเริ่มต้นคลาดเคลื่อนไปเกือบ 1 ชม.
  // ตอนนาทีอยู่ช่วง 58-59 ของทุกชั่วโมง
  const totalMinutes = Number(hour) * 60 + Number(minute);
  const roundedTotal = Math.round(totalMinutes / 5) * 5 % (24 * 60);
  const roundedHour = String(Math.floor(roundedTotal / 60)).padStart(2, "0");
  const roundedMinute = String(roundedTotal % 60).padStart(2, "0");

  document.getElementById("modalDatePicker").value = date;
  renderTimeWheel("pickerHourWheel", 24, 1, roundedHour);
  renderTimeWheel("pickerMinuteWheel", 12, 5, roundedMinute);

  iosPickerCallback = onConfirm;
  document.getElementById("iosPickerBackdrop").classList.add("open");
}

function renderTimeWheel(id, count, step, selectedValue) {
  const wheel = document.getElementById(id);
  const values = Array.from({ length: count }, (_, index) => String(index * step).padStart(2, "0"));
  wheel.innerHTML = values.map(value => `<div class="wheel-item" tabindex="0">${value}</div>`).join("");
  wheel.dataset.values = JSON.stringify(values);
  const selectedIndex = Math.max(0, values.indexOf(selectedValue));

  requestAnimationFrame(() => {
    wheel.scrollTop = selectedIndex * 42;
    updateWheelSelection(wheel);
  });

  wheel.onscroll = () => updateWheelSelection(wheel);
  wheel.onscrollend = () => snapWheelToSelection(wheel);
  wheel.onwheel = (event) => moveWheelByStep(event, wheel);
}

function updateWheelSelection(wheel) {
  const selectedIndex = Math.round(wheel.scrollTop / 42);
  wheel.querySelectorAll(".wheel-item").forEach((item, index) => item.classList.toggle("selected", index === selectedIndex));
}

function snapWheelToSelection(wheel) {
  const selectedIndex = Math.round(wheel.scrollTop / 42);
  wheel.scrollTop = selectedIndex * 42;
  updateWheelSelection(wheel);
}

function moveWheelByStep(event, wheel) {
  event.preventDefault();
  if (wheel.dataset.isStepping === "true") return;

  const values = JSON.parse(wheel.dataset.values || "[]");
  const currentIndex = Math.round(wheel.scrollTop / 42);
  const direction = event.deltaY > 0 ? 1 : -1;
  const nextIndex = Math.max(0, Math.min(values.length - 1, currentIndex + direction));

  if (nextIndex === currentIndex) return;

  wheel.dataset.isStepping = "true";
  wheel.scrollTo({ top: nextIndex * 42, behavior: "smooth" });
  updateWheelSelection(wheel);

  window.setTimeout(() => {
    snapWheelToSelection(wheel);
    wheel.dataset.isStepping = "false";
  }, 160);
}

function selectedWheelValue(id) {
  const wheel = document.getElementById(id);
  const values = JSON.parse(wheel.dataset.values || "[]");
  return values[Math.round(wheel.scrollTop / 42)] || values[0];
}

function closeIosDateTimePicker() {
  document.getElementById("iosPickerBackdrop").classList.remove("open");
  iosPickerCallback = null;
}

function updateDeadlinePickerLabel(value) {
  const button = document.getElementById("taskDeadlinePicker");
  button.querySelector("span").textContent = formatDeadlinePickerLabel(value);
  button.classList.add("has-value");
}

function formatDeadlinePickerLabel(value) {
  const [date, time] = value.split("T");
  const formattedDate = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" })
    .format(new Date(`${date}T12:00:00+07:00`));
  return `${formattedDate} · ${time} น.`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// escapeHtml() ปลอดภัยสำหรับใส่เป็น text content แต่ไม่ escape เครื่องหมาย " —
// ถ้าเอาไปต่อใน attribute ที่ครอบด้วย " (เช่น aria-label="...", value="...")
// ผู้ใช้ที่ตั้งชื่องานเป็น `x" onmouseover="alert(1)` จะหลุดออกจาก attribute เดิม
// และแทรก event handler ใหม่ได้ (stored XSS) ให้ใช้ escapeAttr() แทนในกรณีนั้น
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}


/* =====================================================================
   6. เพิ่มงานใหม่ (พร้อมอัปโหลดไฟล์ ถ้ามี)
   ===================================================================== */
function setupEventListeners() {
  // --- filter tabs ---
  document.getElementById("filterTabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-filter]");
    if (!btn) return;
    document.querySelectorAll("#filterTabs button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    taskPage = 1;
    renderTasks();
  });

  document.getElementById("taskSearch").addEventListener("input", (e) => {
    currentSearch = e.target.value.trim();
    taskPage = 1;
    renderTasks();
  });
  document.getElementById("taskSort").addEventListener("change", (e) => {
    currentSort = e.target.value;
    taskPage = 1;
    renderTasks();
  });

  // --- pagination ---
  document.getElementById("btnPrevPage").addEventListener("click", () => {
    if (taskPage <= 1) return;
    taskPage--;
    renderTasks();
  });
  document.getElementById("btnNextPage").addEventListener("click", () => {
    taskPage++;
    renderTasks();
  });

  const deadlineInput = document.getElementById("taskDeadline");
  document.getElementById("taskDeadlinePicker").addEventListener("click", () => {
    openIosDateTimePicker(deadlineInput.value, (value) => {
      deadlineInput.value = value;
      updateDeadlinePickerLabel(value);
    });
  });
  document.getElementById("iosPickerCancel").addEventListener("click", closeIosDateTimePicker);
  document.getElementById("iosPickerConfirm").addEventListener("click", () => {
    const date = document.getElementById("modalDatePicker").value;
    if (!date) return;
    iosPickerCallback?.(`${date}T${selectedWheelValue("pickerHourWheel")}:${selectedWheelValue("pickerMinuteWheel")}`);
    closeIosDateTimePicker();
  });

  // --- file drop zone ---
  const dropZone = document.getElementById("fileDropZone");
  const fileInput = document.getElementById("taskFile");

  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => handleFileSelect(e.target.files[0]));

  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.style.borderColor = "var(--accent)"; });
  dropZone.addEventListener("dragleave", () => { dropZone.style.borderColor = ""; });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "";
    if (e.dataTransfer.files[0]) handleFileSelect(e.dataTransfer.files[0]);
  });

  // --- add task form ---
  document.getElementById("formAddTask").addEventListener("submit", handleAddTask);

  // --- remove selected file ---
  document.getElementById("removeSelectedFile").addEventListener("click", resetFileSelection);
}

function handleFileSelect(file) {
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) {
    Swal.fire({ icon: "error", title: "ไฟล์ใหญ่เกินไป", text: "ขนาดไฟล์ต้องไม่เกิน 20MB", confirmButtonColor: "#5b6ee1" });
    return;
  }
  selectedFile = file;
  const label = document.getElementById("fileDropLabel");
  const zone = document.getElementById("fileDropZone");
  label.textContent = `เลือกไฟล์: ${file.name}`;
  zone.classList.add("has-file");
  document.getElementById("removeSelectedFile").hidden = false;
}

// กันชื่อไฟล์ที่ผู้ใช้อัปโหลดมีอักขระอันตราย (quote, /, .., ฯลฯ) ก่อนใช้เป็นส่วนหนึ่ง
// ของ storage path — ป้องกัน path traversal และกันชื่อไฟล์หลุดไปทำลาย HTML/JS ตอน render
function sanitizeFileName(name) {
  const raw = String(name || "").normalize("NFC");
  const lastDot = raw.lastIndexOf(".");
  const ext = lastDot > 0 ? raw.slice(lastDot).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 10) : "";
  const base = (lastDot > 0 ? raw.slice(0, lastDot) : raw)
    .replace(/[^a-zA-Z0-9ก-๙_\- ]/gu, "")
    .trim()
    .slice(0, 80);
  return `${base || "file"}${ext}`;
}

function resetFileSelection() {
  selectedFile = null;
  document.getElementById("taskFile").value = "";
  document.getElementById("fileDropLabel").textContent = "ลากไฟล์มาวาง หรือคลิกเพื่อเลือก (สูงสุด 20MB)";
  document.getElementById("fileDropZone").classList.remove("has-file");
  document.getElementById("removeSelectedFile").hidden = true;
}

async function handleAddTask(e) {
  e.preventDefault();
  const btn = document.getElementById("btnAddTask");
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึก...';

  try {
    const taskName = document.getElementById("taskName").value.trim();
    const subjectName = document.getElementById("taskSubject").value.trim();
    const description = document.getElementById("taskDescription").value.trim();
    const deadlineValue = document.getElementById("taskDeadline").value;
    if (!deadlineValue) throw new Error("กรุณาเลือกวันและเวลาส่งงาน");
    const deadline = new Date(`${deadlineValue}:00+07:00`).toISOString();
    const status = document.getElementById("taskStatus").value;
    const reminderOffsetMinutes = Number(document.getElementById("taskReminder").value);

    // 1) insert แถวงานก่อน เพื่อเอา task id ไปตั้งชื่อ path ไฟล์
    const { data: inserted, error: insertError } = await sb
      .from("tasks")
      .insert({
        task_name: taskName,
        subject_name: subjectName,
        description: description || null,
        deadline,
        user_id: currentUser.id,
        status,
        reminder_offset_minutes: reminderOffsetMinutes
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // 2) ถ้ามีไฟล์แนบ อัปโหลดขึ้น Storage แล้วอัปเดต file_url
    //    หมายเหตุ: ถ้าขั้นตอนไหนใน 2) fail จะ rollback งานที่ insert ไปแล้วในข้อ 1)
    //    เพื่อไม่ให้เหลืองานค้างที่ไม่มีไฟล์แนบ (หรือไฟล์กำพร้าที่ไม่ผูกกับงานไหนเลย)
    if (selectedFile) {
      const filePath = `${currentUser.id}/${inserted.id}/${sanitizeFileName(selectedFile.name)}`;
      const { error: uploadError } = await sb.storage
        .from(BUCKET_NAME)
        .upload(filePath, selectedFile, { upsert: true });

      if (uploadError) {
        await sb.from("tasks").delete().eq("id", inserted.id);
        throw uploadError;
      }

      const { error: updateError } = await sb
        .from("tasks")
        .update({ file_url: filePath })
        .eq("id", inserted.id);

      if (updateError) {
        // ไฟล์อัปโหลดสำเร็จแล้วแต่ผูกกับงานไม่ได้ -> ลบทั้งไฟล์กำพร้าและงานทิ้ง
        await sb.storage.from(BUCKET_NAME).remove([filePath]);
        await sb.from("tasks").delete().eq("id", inserted.id);
        throw updateError;
      }
    }

    // 3) reset ฟอร์ม
    document.getElementById("formAddTask").reset();
    resetFileSelection();

    Swal.fire({ icon: "success", title: "บันทึกงานสำเร็จ", timer: 1200, showConfirmButton: false });

    await loadTasks(); // realtime จะ trigger ให้เองอยู่แล้ว แต่เรียกซ้ำเพื่อความชัวร์เรื่อง join ข้อมูล

  } catch (err) {
    console.error(err);
    Swal.fire({ icon: "error", title: "บันทึกไม่สำเร็จ", text: err.message, confirmButtonColor: "#5b6ee1" });
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> บันทึกงาน';
  }
}


/* =====================================================================
   7. ดาวน์โหลดไฟล์แนบ (สร้าง signed URL ชั่วคราว เพราะ bucket เป็น private)
   ===================================================================== */
async function downloadFile(taskId) {
  // รับ taskId (UUID จาก DB) แทนการรับ path ตรงๆ แล้วค่อยไปหา file_url เอง
  // กัน path/ชื่อไฟล์ที่มาจากผู้ใช้ถูกฝังลง onclick attribute ตรงๆ (XSS)
  const task = allTasks.find(t => t.id === taskId);
  if (!task?.file_url) return;

  const { data, error } = await sb.storage
    .from(BUCKET_NAME)
    .createSignedUrl(task.file_url, 60); // ลิงก์ใช้ได้ 60 วินาที

  if (error) {
    Swal.fire({ icon: "error", title: "เปิดไฟล์ไม่ได้", text: error.message, confirmButtonColor: "#5b6ee1" });
    return;
  }
  window.open(data.signedUrl, "_blank");
}


/* =====================================================================
   8. สลับสถานะงานแบบเร็ว (คลิกที่ badge)
   ===================================================================== */
async function updateTaskStatus(taskId, newStatus) {
  const { error } = await sb
    .from("tasks")
    .update({ status: newStatus })
    .eq("id", taskId);

  if (error) {
    Swal.fire({ icon: "error", title: "อัปเดตสถานะไม่สำเร็จ", text: error.message, confirmButtonColor: "#5b6ee1" });
    return;
  }
  await loadTasks();
}

function renderToday() {
  const date = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short" }).format(new Date());
  document.getElementById("todayDate").textContent = date;
}


/* =====================================================================
   9. แก้ไขงาน (เปิด modal ผ่าน SweetAlert2)
   ===================================================================== */
function openEditModal(taskId) {
  const task = allTasks.find(t => t.id === taskId);
  if (!task) return;

  const deadlineParts = getBangkokParts(new Date(task.deadline));
  const deadlineValue = `${deadlineParts.date}T${deadlineParts.hour}:${deadlineParts.minute}`;

  Swal.fire({
    title: '<i class="fa-regular fa-pen-to-square"></i> แก้ไขงาน',
    customClass: { popup: "task-edit-modal", htmlContainer: "task-edit-modal__content" },
    html: `
      <div class="task-edit-form">
        <label class="task-edit-field">ชื่องาน
          <input id="swalTaskName" value="${escapeAttr(task.task_name)}">
        </label>
        <label class="task-edit-field">วิชา
          <input id="swalSubjectName" value="${escapeAttr(task.subject_name)}">
        </label>
        <label class="task-edit-field">รายละเอียด
          <textarea id="swalDescription" placeholder="รายละเอียดเพิ่มเติม (ถ้ามี)">${escapeHtml(task.description || "")}</textarea>
        </label>
        <label class="task-edit-field">วันครบกำหนดส่ง <span>เวลาไทย</span>
          <input id="swalDeadline" type="hidden" value="${deadlineValue}">
          <button id="swalDeadlinePicker" class="deadline-picker-trigger has-value" type="button">
            <i class="fa-regular fa-calendar"></i>
            <span>${formatDeadlinePickerLabel(deadlineValue)}</span>
            <i class="fa-solid fa-chevron-right"></i>
          </button>
        </label>
        <div class="task-edit-grid">
          <label class="task-edit-field">สถานะ
            <select id="swalStatus">
          <option value="pending" ${task.status === "pending" ? "selected" : ""}>ยังไม่เริ่ม</option>
          <option value="in_progress" ${task.status === "in_progress" ? "selected" : ""}>กำลังทำ</option>
          <option value="submitted" ${task.status === "submitted" ? "selected" : ""}>ส่งแล้ว</option>
          <option value="cancelled" ${task.status === "cancelled" ? "selected" : ""}>ยกเลิก</option>
            </select>
          </label>
          <label class="task-edit-field">เตือนผ่าน LINE
            <select id="swalReminder">
          <option value="1440" ${task.reminder_offset_minutes === 1440 ? "selected" : ""}>ก่อนส่ง 1 วัน</option>
          <option value="180" ${task.reminder_offset_minutes === 180 ? "selected" : ""}>ก่อนส่ง 3 ชม.</option>
          <option value="60" ${task.reminder_offset_minutes === 60 ? "selected" : ""}>ก่อนส่ง 1 ชม.</option>
          <option value="0" ${task.reminder_offset_minutes === 0 ? "selected" : ""}>ไม่แจ้งเตือน</option>
            </select>
          </label>
        </div>
      </div>
    `,
    confirmButtonText: "บันทึกการแก้ไข",
    confirmButtonColor: "#5b6ee1",
    showCancelButton: true,
    cancelButtonText: "ยกเลิก",
    didOpen: () => {
      const deadlineInput = document.getElementById("swalDeadline");
      const deadlineButton = document.getElementById("swalDeadlinePicker");
      deadlineButton.addEventListener("click", () => {
        openIosDateTimePicker(deadlineInput.value, (value) => {
          deadlineInput.value = value;
          deadlineButton.querySelector("span").textContent = formatDeadlinePickerLabel(value);
        });
      });
    },
    preConfirm: () => {
      const newDeadline = new Date(`${document.getElementById("swalDeadline").value}:00+07:00`).toISOString();
      const newReminder = Number(document.getElementById("swalReminder").value);

      // รีเซ็ต notify_stage เฉพาะตอนที่ deadline หรือรอบแจ้งเตือนเปลี่ยนจริงๆ เท่านั้น
      // (เทียบด้วย Date object เพราะ deadline ที่ได้จาก DB กับที่คำนวณใหม่อาจต่าง format
      // กัน แม้ค่าเวลาจริงจะเท่ากัน) — ถ้าแก้แค่ชื่องาน/รายละเอียด/สถานะ จะไม่ไปรีเซ็ต
      // สถานะแจ้งเตือนที่ส่งไปแล้ว ป้องกันการส่งแจ้งเตือนซ้ำโดยไม่จำเป็น
      const deadlineChanged = new Date(newDeadline).getTime() !== new Date(task.deadline).getTime();
      const reminderChanged = newReminder !== task.reminder_offset_minutes;

      return {
        task_name: document.getElementById("swalTaskName").value.trim(),
        subject_name: document.getElementById("swalSubjectName").value.trim(),
        description: document.getElementById("swalDescription").value.trim() || null,
        deadline: newDeadline,
        status: document.getElementById("swalStatus").value,
        reminder_offset_minutes: newReminder,
        ...(deadlineChanged || reminderChanged ? { notify_stage: null } : {})
      };
    }
  }).then(async (result) => {
    if (!result.isConfirmed) return;

    const { error } = await sb.from("tasks").update(result.value).eq("id", taskId);
    if (error) {
      Swal.fire({ icon: "error", title: "แก้ไขไม่สำเร็จ", text: error.message, confirmButtonColor: "#5b6ee1" });
      return;
    }
    Swal.fire({ icon: "success", title: "แก้ไขสำเร็จ", timer: 1000, showConfirmButton: false });
    await loadTasks();
  });
}


/* =====================================================================
   10. ลบงาน
   ===================================================================== */
async function deleteTask(taskId) {
  const confirm = await Swal.fire({
    icon: "warning",
    title: "ลบงานนี้?",
    text: "ไม่สามารถกู้คืนได้หลังจากลบแล้ว",
    showCancelButton: true,
    confirmButtonText: "ลบ",
    cancelButtonText: "ยกเลิก",
    confirmButtonColor: "#e2574c"
  });
  if (!confirm.isConfirmed) return;

  const { error } = await sb.from("tasks").delete().eq("id", taskId);
  if (error) {
    Swal.fire({ icon: "error", title: "ลบไม่สำเร็จ", text: error.message, confirmButtonColor: "#5b6ee1" });
    return;
  }
  await loadTasks();
}


/* =====================================================================
   11. REALTIME — subscribe การเปลี่ยนแปลงของตาราง tasks
   ===================================================================== */
function setupRealtime() {
  sb.channel("tasks-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => {
      loadTasks();
    })
    .subscribe();
}


/* =====================================================================
   12. เชื่อมต่อ LINE — ขอรหัสเชื่อมต่อ 6 หลัก แล้วให้ผู้ใช้ไปพิมพ์ใน LINE OA
   ===================================================================== */
async function handleLineConnect() {
  // ถ้าเชื่อมต่อไว้แล้ว ถามว่าจะยกเลิกไหม
  if (currentProfile?.line_token) {
    const confirm = await Swal.fire({
      icon: "question",
      title: "ยกเลิกการเชื่อมต่อ LINE?",
      text: "คุณจะไม่ได้รับการแจ้งเตือนผ่าน LINE อีกต่อไป",
      showCancelButton: true,
      confirmButtonText: "ยกเลิกการเชื่อมต่อ",
      cancelButtonText: "ปิด",
      confirmButtonColor: "#e2574c"
    });
    if (!confirm.isConfirmed) return;

    const { error } = await sb.rpc("unlink_line");
    if (error) {
      Swal.fire({ icon: "error", title: "ทำรายการไม่สำเร็จ", text: error.message, confirmButtonColor: "#5b6ee1" });
      return;
    }
    await loadProfile();
    Swal.fire({ icon: "success", title: "ยกเลิกการเชื่อมต่อแล้ว", timer: 1200, showConfirmButton: false });
    return;
  }

  // ยังไม่เชื่อมต่อ -> ขอรหัสใหม่
  const { data: code, error } = await sb.rpc("generate_line_link_code");
  if (error) {
    Swal.fire({ icon: "error", title: "สร้างรหัสไม่สำเร็จ", text: error.message, confirmButtonColor: "#5b6ee1" });
    return;
  }

  const addFriendUrl = `https://line.me/R/ti/p/%40${LINE_OA_ID}`;
  // ใช้ไฟล์ QR code จริงที่ดาวน์โหลดมาจาก LINE Official Account Manager
  // (ไฟล์ line-qr.png ต้องอยู่โฟลเดอร์เดียวกับ index.html)
  const qrCodeUrl = "line-qr.png";

  Swal.fire({
    showCloseButton: true,
    customClass: { popup: "line-modal-popup" },
    html: `
      <div class="line-connect-dialog">
        <header class="line-modal-header">
          <i class="fa-brands fa-line" aria-hidden="true"></i>
          <h2 class="line-modal-title">เชื่อมต่อ LINE</h2>
          <p>รับการแจ้งเตือนงานใกล้ครบกำหนดได้ทันที</p>
        </header>

        <section class="line-step-card">
          <p class="line-step-title"><span class="line-step-badge">ขั้นตอน 1</span> เพิ่มเพื่อน LINE OA</p>
          <div class="line-qr-box">
            <img src="${qrCodeUrl}" alt="QR Code สำหรับเพิ่มเพื่อน LINE OA">
          </div>
          <a href="${addFriendUrl}" target="_blank" rel="noopener" class="btn-line-add">
            <i class="fa-brands fa-line"></i> เปิด LINE เพื่อเพิ่มเพื่อน
          </a>
        </section>

        <section class="line-step-card">
          <p class="line-step-title"><span class="line-step-badge">ขั้นตอน 2</span> ส่งรหัสนี้ในแชท ภายใน 10 นาที</p>
          <div class="otp-code-box" title="แตะเพื่อเลือกรหัส">${code}</div>
          <p class="line-modal-footer-note"><i class="fa-solid fa-circle-info"></i> หลังเชื่อมต่อสำเร็จแล้ว กลับมารีเฟรชหน้านี้เพื่ออัปเดตสถานะ</p>
        </section>
      </div>
    `,
    confirmButtonText: "รับทราบ",
    confirmButtonColor: "#5b6ee1",
    width: 380
  });
}


/* =====================================================================
   13. LOGOUT
   ===================================================================== */
async function handleLogout() {
  const confirm = await Swal.fire({
    icon: "question",
    title: "ออกจากระบบ?",
    showCancelButton: true,
    confirmButtonText: "ออกจากระบบ",
    cancelButtonText: "ยกเลิก",
    confirmButtonColor: "#5b6ee1"
  });
  if (!confirm.isConfirmed) return;

  clearInterval(countdownTimer);
  await sb.auth.signOut();
  window.location.href = "auth.html";
}
/* =====================================================================
   14. DARK/LIGHT THEME TOGGLE
   ===================================================================== */
function initTheme() {
  const savedTheme = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  updateThemeIcon(savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", current);
  localStorage.setItem("theme", current);
  updateThemeIcon(current);
}

function updateThemeIcon(theme) {
  const icon = document.getElementById("themeIcon");
  if (icon) icon.className = theme === "dark" ? "fa-solid fa-sun" : "fa-solid fa-moon";
}

// เรียกใช้ initTheme() ภายในฟังก์ชัน init() หรือบนสุดของไฟล์
initTheme();
