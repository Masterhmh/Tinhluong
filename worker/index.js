export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Telegram salary bot is running.");
    }

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response("OK", {
        headers: corsHeaders(),
      });
    }

    if (request.method === "POST" && url.pathname === "/miniapp-open") {
      return handleMiniAppOpen(request, env);
    }

    if (request.method === "POST" && url.pathname === "/miniapp-data") {
      return handleMiniAppPost(request, env);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let update;

    try {
      update = await request.json();
    } catch (err) {
      console.log("ERROR: Cannot parse request JSON:", err);
      return new Response("Bad Request", { status: 400 });
    }

    try {
      await handleUpdate(update, env);
    } catch (err) {
      console.error("handleUpdate error:", err);
    }

    return new Response("OK");
  },
};

async function handleUpdate(update, env) {
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  if (!msg) {
    console.log("No message object found");
    return;
  }

  const chatId = msg.chat && msg.chat.id;
  const text = (msg.text || "").trim();

  await trackUser(env, msg);

  console.log("Incoming text:", text, "chatId:", chatId);

  if (!chatId) {
    console.log("No chatId found");
    return;
  }

  if (text === "/ping" || text.startsWith("/ping@")) {
    return sendMessage(env, chatId, "pong");
  }

  if (text === "/whoami" || text.startsWith("/whoami@")) {
    return sendMessage(
      env,
      chatId,
      "🆔 Telegram ID của bạn: <code>" +
        (msg.from ? msg.from.id : "?") +
        "</code>",
      null,
      "HTML"
    );
  }

  if (text === "/thongke" || text.startsWith("/thongke@")) {
    return sendThongKe(env, chatId, msg.from && msg.from.id);
  }

  if (text === "/miniapp" || text.startsWith("/miniapp@")) {
    await setMenuButton(env);

    return sendMessage(
      env,
      chatId,
      [
        "<b>✅ Đã bật nút Mini App</b>",
        "Nút <b>Tính lương</b> sẽ hiện ở cạnh khung nhập tin nhắn.",
        "Chưa thấy? Hãy đóng Telegram rồi mở lại.",
        "",
        "Hoặc bấm nút bên dưới để mở ngay.",
      ].join("\n"),
      miniAppKeyboard(env),
      "HTML"
    );
  }

  if (msg.web_app_data && msg.web_app_data.data) {
    return handleMiniAppData(chatId, msg.web_app_data.data, env);
  }

  if (text === "/start" || text.startsWith("/start@")) {
    return sendMessage(
      env,
      chatId,
      [
        "<b>👋 Chào bạn!</b>",
        "Mình là bot tính lương hàng tháng.",
        "",
        "<b>Chọn 1 trong 2 cách:</b>",
        "🧮 Bấm nút bên dưới để nhập trên <b>Mini App</b> — nhanh và trực quan nhất",
        "⌨️ Hoặc gõ /luongthang để nhận mẫu nhập bằng tin nhắn",
        "",
        "Gõ /huongdan nếu muốn xem hướng dẫn đầy đủ.",
      ].join("\n"),
      miniAppKeyboard(env),
      "HTML"
    );
  }

  if (isHuongDanCommand(text)) {
    return sendHuongDan(env, chatId);
  }

  if (isLuongThangCommand(text)) {
    const month = getMonthFromCommand(text);
    return sendSalaryTemplate(env, chatId, month);
  }

  if (looksLikeSalaryForm(text)) {
    const input = parseSalaryForm(text);
    const result = calculateSalary(input);
    return sendMessage(env, chatId, formatSalaryResult(result), null, "HTML");
  }

  console.log("No command matched:", text);
}

function miniAppKeyboard(env) {
  return {
    inline_keyboard: [
      [
        {
          text: "🧮 Mở Mini App tính lương",
          web_app: {
            url: env.MINI_APP_URL,
          },
        },
      ],
    ],
  };
}

/* ===================== THỐNG KÊ NGƯỜI DÙNG ===================== */

async function trackFrom(env, from, kind) {
  if (!env.STATS || !from || !from.id || from.is_bot) return;

  const key = "user:" + from.id;
  const now = Date.now();

  let rec = null;

  try {
    rec = await env.STATS.get(key, "json");
  } catch (err) {
    console.log("KV get error:", err);
  }

  if (!rec) {
    rec = { id: from.id, first: now, count: 0, botCount: 0, appCount: 0 };
  }

  if (from.first_name || from.last_name) {
    rec.name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  }

  if (from.username) rec.username = from.username;

  rec.last = now;
  rec.count = (rec.count || 0) + 1;

  if (kind === "miniapp") {
    rec.appCount = (rec.appCount || 0) + 1;
    rec.lastApp = now;
  } else {
    rec.botCount = (rec.botCount || 0) + 1;
    rec.lastBot = now;
  }

  try {
    await env.STATS.put(key, JSON.stringify(rec));
  } catch (err) {
    console.log("KV put error:", err);
  }
}

async function trackUser(env, msg) {
  const from = msg && msg.from;
  const kind = msg && msg.web_app_data ? "miniapp" : "bot";
  return trackFrom(env, from, kind);
}

async function listUsers(env) {
  const keys = [];
  let cursor;

  do {
    const res = await env.STATS.list({ prefix: "user:", cursor });
    res.keys.forEach((k) => keys.push(k.name));
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  const users = [];

  for (const key of keys) {
    try {
      const rec = await env.STATS.get(key, "json");
      if (rec) users.push(rec);
    } catch (err) {
      console.log("KV read error:", key);
    }
  }

  return users;
}

async function sendThongKe(env, chatId, fromId) {
  if (!env.STATS) {
    return sendMessage(
      env,
      chatId,
      "⚠️ Chưa bật KV. Hãy tạo namespace và thêm binding STATS trong wrangler.toml."
    );
  }

  if (env.ADMIN_ID && String(fromId) !== String(env.ADMIN_ID)) {
    return sendMessage(env, chatId, "🔒 Lệnh này chỉ dành cho quản trị viên.");
  }

  const users = await listUsers(env);
  const now = Date.now();
  const day = 86400000;

  const active7 = users.filter((u) => now - (u.last || 0) <= 7 * day).length;
  const active30 = users.filter((u) => now - (u.last || 0) <= 30 * day).length;
  const new7 = users.filter((u) => now - (u.first || 0) <= 7 * day).length;

  const appUsers = users.filter((u) => (u.appCount || 0) > 0);
  const botUsers = users.filter((u) => (u.botCount || 0) > 0);
  const onlyApp = users.filter(
    (u) => (u.appCount || 0) > 0 && !(u.botCount || 0)
  ).length;

  const totalMsg = users.reduce((s, u) => s + (u.count || 0), 0);
  const totalApp = users.reduce((s, u) => s + (u.appCount || 0), 0);

  const top = users
    .slice()
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 10);

  const sep = "━━━━━━━━━━━━━━━━━━━";
  const L = [];

  L.push(sep);
  L.push("<b>📊 THỐNG KÊ NGƯỜI DÙNG</b>");
  L.push(sep);
  L.push(`👥 Tổng số người dùng: <b>${users.length}</b>`);
  L.push(`🟢 Hoạt động 7 ngày: <b>${active7}</b>`);
  L.push(`🔵 Hoạt động 30 ngày: <b>${active30}</b>`);
  L.push(`✨ Người mới 7 ngày: <b>${new7}</b>`);
  L.push(sep);
  L.push("<b>📱 THEO CÁCH DÙNG</b>");
  L.push(`• Đã mở Mini App: <b>${appUsers.length}</b> người`);
  L.push(`• Đã nhắn tin cho bot: <b>${botUsers.length}</b> người`);
  L.push(`• Chỉ dùng Mini App: <b>${onlyApp}</b> người`);
  L.push(sep);
  L.push("<b>💬 LƯỢT TƯƠNG TÁC</b>");
  L.push(`• Tổng: <b>${totalMsg}</b>`);
  L.push(`• Lượt mở Mini App: <b>${totalApp}</b>`);

  if (top.length) {
    L.push(sep);
    L.push("<b>🏆 DÙNG NHIỀU NHẤT</b>");

    top.forEach((u, i) => {
      const who = u.username
        ? "@" + u.username
        : escapeHtml(u.name || "ID " + u.id);

      L.push(
        `${i + 1}. ${who} — <b>${u.count || 0}</b> lượt (app ${u.appCount || 0})`
      );
    });
  }

  L.push(sep);
  L.push(`<i>🕒 Cập nhật ${nowVN()}</i>`);

  return sendMessage(env, chatId, L.join("\n"), null, "HTML");
}

/* ===================== LỆNH ===================== */

function isHuongDanCommand(text) {
  const clean = text.replace(/@\w+/g, "");
  return /^\/huongdan$/i.test(clean);
}

function isLuongThangCommand(text) {
  const clean = text.replace(/@\w+/g, "");
  return /^\/luongthang(\s+\d{1,2}|\d{1,2})?$/i.test(clean);
}

function getMonthFromCommand(text) {
  const currentMonth = getCurrentMonthVN();
  const clean = text.replace(/@\w+/g, "");

  let match = clean.match(/^\/luongthang\s+(\d{1,2})$/i);
  if (match) return clampMonth(Number(match[1]), currentMonth);

  match = clean.match(/^\/luongthang(\d{1,2})$/i);
  if (match) return clampMonth(Number(match[1]), currentMonth);

  return currentMonth;
}

function clampMonth(month, fallback) {
  if (!month || month < 1 || month > 12) return fallback;
  return month;
}

async function sendHuongDan(env, chatId) {
  const sep = "━━━━━━━━━━━━━━━━━━━";

  const text = [
    sep,
    "<b>📘 HƯỚNG DẪN SỬ DỤNG</b>",
    sep,
    "<b>1. Cách nhanh nhất — Mini App</b>",
    "Bấm nút <b>Mở Mini App tính lương</b> ở dưới, nhập số liệu rồi bấm <b>Gửi về bot</b>.",
    "Bạn cũng có thể xuất bảng lương thành ảnh PNG.",
    "Nếu chưa thấy nút menu ở khung chat, gõ /miniapp.",
    "",
    "<b>2. Cách nhập bằng tin nhắn</b>",
    "• Gõ /luongthang → bot gửi mẫu của tháng hiện tại",
    "• Gõ /luongthang 7 → mẫu tháng 7",
    "Copy mẫu, điền số vào sau dấu hai chấm rồi gửi lại.",
    "Bạn cứ viết tiếng Việt bình thường, ví dụ:",
    "<code>Lương cơ bản: 9tr</code>",
    "<code>Ngày công: 24</code>",
    "Không cần viết đúng dấu, bot vẫn hiểu. Dòng nào không điền thì tính là <b>0</b>.",
    "",
    "<b>3. Cách viết số tiền</b>",
    "Viết kiểu nào cũng được:",
    "<code>9tr</code> = 9.000.000 • <code>1tr2</code> = 1.200.000",
    "<code>500k</code> = 500.000 • <code>1200000</code> • <code>1.200.000</code>",
    "",
    "<b>4. Thêm khoản cộng tự đặt tên</b>",
    "Dùng dòng <code>Cộng thêm: Tên khoản | Số tiền</code>",
    "Ví dụ: <code>Cộng thêm: Hoa hồng | 500k</code>",
    "Có thể thêm nhiều dòng <b>Cộng thêm</b> khác nhau.",
    "",
    "<b>5. Lịch nghỉ hàng tuần</b>",
    "Mặc định bot chỉ trừ Chủ nhật.",
    "Nếu công ty nghỉ cả Thứ 7, thêm dòng <code>Nghỉ thứ 7: có</code>.",
    "Lịch nghỉ đặc biệt (T7 cách tuần, nghỉ lễ dài) thì ấn định thẳng:",
    "<code>Ngày làm việc: 23</code>",
    "",
    "<b>6. Cách bot tính lương</b>",
    "• Ngày làm việc = số ngày trong tháng − ngày nghỉ tuần",
    "• Lương / ngày = lương cơ bản ÷ ngày làm việc",
    "• Lương ngày công = lương / ngày × ngày công thực tế",
    "• Phụ cấp trách nhiệm = hệ số × lương ngày công",
    "• Tiền ăn = tiền ăn 1 buổi × ngày công thực tế",
    "• Thực nhận = tổng khoản cộng − tổng khoản trừ",
    "",
    sep,
    "<b>📋 DANH SÁCH LỆNH</b>",
    "/luongthang — mẫu nhập của tháng hiện tại",
    "/luongthang 7 — mẫu nhập tháng 7",
    "/miniapp — bật lại nút Mini App",
    "/huongdan — xem hướng dẫn này",
    "/ping — kiểm tra bot còn hoạt động",
    sep,
  ].join("\n");

  return sendMessage(env, chatId, text, miniAppKeyboard(env), "HTML");
}

async function sendSalaryTemplate(env, chatId, month) {
  const year = getCurrentYearVN();
  const info = getWorkingInfo(year, month);

  const form = [
    "Tháng: " + month,
    "Lương cơ bản:",
    "Ngày công:",
    "Nghỉ thứ 7: không",
    "Hệ số trách nhiệm:",
    "Tiền ăn 1 buổi:",
    "Trợ cấp:",
    "Công tác phí:",
    "Thưởng nóng:",
    "Tăng ca:",
    "Upsell:",
    "Cộng thêm: Hoa hồng | 0",
    "Đi muộn:",
    "Phạt:",
    "Ứng lương:",
  ].join("\n");

  const text = [
    `<b>📌 TÍNH LƯƠNG THÁNG ${pad2(month)}/${year}</b>`,
    `Tháng này có <b>${info.totalDays} ngày</b> · <b>${info.sundayCount} Chủ nhật</b> · <b>${info.saturdayCount} Thứ 7</b>`,
    "",
    "Bấm vào khối dưới để copy → điền số vào sau dấu hai chấm → gửi lại cho mình.",
    "<b>Dòng nào không điền thì mặc định là 0.</b>",
    `<pre>${form}</pre>`,
    "<b>💡 Giải thích</b>",
    "• <b>Lương cơ bản</b> — lương 1 tháng ghi trên hợp đồng",
    "• <b>Ngày công</b> — số ngày bạn thực tế đi làm trong tháng",
    "• <b>Nghỉ thứ 7</b> — ghi <code>có</code> nếu nghỉ cả T7, ghi <code>không</code> nếu vẫn làm",
    "• <b>Hệ số trách nhiệm</b> — ví dụ 0.03, không có thì để trống",
    "• <b>Tiền ăn 1 buổi</b> — bot tự nhân với số ngày công",
    "• <b>Cộng thêm</b> — khoản tự đặt tên, viết <code>Tên khoản | Số tiền</code>",
    "  Ví dụ <code>Cộng thêm: Hoa hồng | 500k</code>, thêm được nhiều dòng",
    "",
    "<b>Số tiền viết kiểu nào cũng hiểu</b>",
    "<code>9tr</code> · <code>1tr2</code> · <code>500k</code> · <code>1200000</code> · <code>1.200.000</code>",
    "",
    "Lịch nghỉ đặc biệt? Thêm dòng <code>Ngày làm việc: 23</code> để tự ấn định.",
    "",
    "🧮 Không muốn gõ? Bấm nút dưới để nhập trên Mini App.",
  ].join("\n");

  return sendMessage(env, chatId, text, miniAppKeyboard(env), "HTML");
}

/* ===================== ĐỌC DỮ LIỆU ===================== */

const KEY_MAP = {
  thang: "luongthang",
  luongthang: "luongthang",
  thang_luong: "luongthang",
  nam: "nam",

  luong_co_ban: "luong_co_ban",
  luong_co_ban_thang: "luong_co_ban",
  luong_cb: "luong_co_ban",

  ngay_cong: "ngay_cong",
  ngay_cong_thuc_te: "ngay_cong",
  so_ngay_cong: "ngay_cong",
  ngay_di_lam: "ngay_cong",

  nghi_thu_7: "nghi_thu_7",
  nghi_t7: "nghi_thu_7",
  co_nghi_thu_7: "nghi_thu_7",

  ngay_lam_viec: "ngay_lam_viec",
  so_ngay_lam_viec: "ngay_lam_viec",

  he_so_trach_nhiem: "he_so_trach_nhiem",
  he_so: "he_so_trach_nhiem",
  hs_trach_nhiem: "he_so_trach_nhiem",

  tien_an_1_buoi: "tien_an_1_buoi",
  tien_an: "tien_an_1_buoi",
  tien_an_1_ngay: "tien_an_1_buoi",

  tro_cap: "tro_cap",
  phu_cap: "tro_cap",
  cong_tac_phi: "cong_tac_phi",
  thuong_nong: "thuong_nong",
  thuong: "thuong_nong",
  tang_ca: "tang_ca",
  lam_them_gio: "tang_ca",
  upsell: "upsell",

  di_muon: "di_muon",
  tru_di_muon: "di_muon",
  phat: "phat",
  ung_luong: "ung_luong",
  tam_ung: "ung_luong",

  cong_them: "cong_them",
  khoan_cong_them: "cong_them",
  khoan_khac: "cong_them",
};

function normalizeKey(raw) {
  return String(raw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function canonicalKey(raw) {
  const k = normalizeKey(raw);
  return KEY_MAP[k] || k;
}

function parseYesNo(raw) {
  const s = normalizeKey(raw || "");
  if (!s) return false;
  return ["co", "yes", "y", "true", "1", "x", "ok", "dung"].includes(s);
}

function looksLikeSalaryForm(text) {
  return text.split("\n").some((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) return false;
    return Boolean(KEY_MAP[normalizeKey(line.slice(0, idx))]);
  });
}

function parseSalaryForm(text) {
  const map = {};
  const extraCong = [];

  text.split("\n").forEach((line) => {
    const rawLine = line.trim();
    if (!rawLine || rawLine.startsWith("#")) return;

    const idx = rawLine.indexOf(":");
    if (idx === -1) return;

    const key = canonicalKey(rawLine.slice(0, idx));
    const value = rawLine.slice(idx + 1).trim();

    if (key === "cong_them") {
      const parts = value.split("|");
      const name = (parts[0] || "Khoản cộng khác").trim();
      const amount = parseMoney(parts[1] || "");

      if (amount > 0) {
        extraCong.push({
          name: name || "Khoản cộng khác",
          value: amount,
        });
      }

      return;
    }

    map[key] = value;
  });

  return {
    month: parseNumber(map.luongthang) || getCurrentMonthVN(),
    year: parseNumber(map.nam) || getCurrentYearVN(),

    baseSalary: parseMoney(map.luong_co_ban) || 0,
    actualDays: parseNumber(map.ngay_cong) || 0,

    saturdayOff: parseYesNo(map.nghi_thu_7),
    workingDaysOverride: parseNumber(map.ngay_lam_viec) || 0,

    responsibilityCoef: parseNumber(map.he_so_trach_nhiem) || 0,

    mealPerDay: parseMoney(map.tien_an_1_buoi) || 0,

    allowance: parseMoney(map.tro_cap) || 0,
    businessFee: parseMoney(map.cong_tac_phi) || 0,
    bonus: parseMoney(map.thuong_nong) || 0,
    overtime: parseMoney(map.tang_ca) || 0,
    upsell: parseMoney(map.upsell) || 0,

    extraCong,

    latePenalty: parseMoney(map.di_muon) || 0,
    penalty: parseMoney(map.phat) || 0,
    advance: parseMoney(map.ung_luong) || 0,
  };
}

async function handleMiniAppData(chatId, rawData, env) {
  let data;

  try {
    data = JSON.parse(rawData);
  } catch {
    return sendMessage(env, chatId, "❌ Không đọc được dữ liệu từ Mini App.");
  }

  const input = normalizeMiniAppInput(data);
  const result = calculateSalary(input);

  return sendMessage(env, chatId, formatSalaryResult(result), null, "HTML");
}

async function handleMiniAppOpen(request, env) {
  let body;

  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const from = body.user || {};

  if (!from.id) {
    return jsonResponse({ ok: false, error: "Missing user" }, 400);
  }

  await trackFrom(env, from, "miniapp");

  return jsonResponse({ ok: true });
}

async function handleMiniAppPost(request, env) {
  let body;

  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: "Invalid JSON",
      },
      400
    );
  }

  const user = body.user || {};
  const chatId = user.id || body.chatId;

  if (!chatId) {
    return jsonResponse(
      {
        ok: false,
        error: "Missing chatId",
      },
      400
    );
  }

  const data = body.data || body;

  await trackFrom(env, user, "miniapp");

  const input = normalizeMiniAppInput(data);
  const result = calculateSalary(input);

  await sendMessage(env, chatId, formatSalaryResult(result), null, "HTML");

  return jsonResponse({
    ok: true,
  });
}

function normalizeMiniAppInput(data) {
  return {
    month: Number(data.month || getCurrentMonthVN()),
    year: Number(data.year || getCurrentYearVN()),

    saturdayOff: data.cheDo === "cn_t7",
    workingDaysOverride: Number(data.ngayLV || 0),

    baseSalary: Number(data.baseSalary || data.lcb || 0),
    actualDays: Number(data.actualDays || data.nc || 0),

    responsibilityCoef: Number(data.responsibilityCoef || data.hs || 0),

    mealPerDay: Number(data.mealPerDay || data.ta || 0),

    allowance: Number(data.allowance || data.tc || 0),
    businessFee: Number(data.businessFee || data.ctp || 0),
    bonus: Number(data.bonus || data.th || 0),
    overtime: Number(data.overtime || data.ot || 0),
    upsell: Number(data.upsell || data.ups || 0),

    extraCong: Array.isArray(data.extraCong) ? data.extraCong : [],

    latePenalty: Number(data.latePenalty || data.dm || 0),
    penalty: Number(data.penalty || data.ph || 0),
    advance: Number(data.advance || data.ung || 0),
  };
}

/* ===================== TÍNH LƯƠNG ===================== */

function calculateSalary(input) {
  const year = Number(input.year) || getCurrentYearVN();

  const workingInfo = getWorkingInfo(
    year,
    input.month,
    input.saturdayOff,
    input.workingDaysOverride
  );

  const baseSalary = input.baseSalary || 0;
  const actualDays = input.actualDays || 0;

  const salaryPerDay =
    workingInfo.workingDays > 0 ? baseSalary / workingInfo.workingDays : 0;

  const salaryByDay = Math.round(salaryPerDay * actualDays);

  // Mức cơ sở tính trách nhiệm
  // = lương cơ bản ÷ ngày làm việc × ngày công thực tế
  const responsibilityBase = salaryByDay;
  const responsibilityCoef = Number(input.responsibilityCoef || 0);
  const responsibility = Math.round(responsibilityBase * responsibilityCoef);

  const mealPerDay = Number(input.mealPerDay || 0);
  const meal = Math.round(mealPerDay * actualDays);

  const extraCong = Array.isArray(input.extraCong) ? input.extraCong : [];
  const extraCongTotal = extraCong.reduce((sum, item) => {
    return sum + Number(item.value || 0);
  }, 0);

  const plus =
    salaryByDay +
    responsibility +
    meal +
    Number(input.allowance || 0) +
    Number(input.businessFee || 0) +
    Number(input.bonus || 0) +
    Number(input.overtime || 0) +
    Number(input.upsell || 0) +
    extraCongTotal;

  const minus =
    Number(input.latePenalty || 0) +
    Number(input.penalty || 0) +
    Number(input.advance || 0);

  return {
    month: input.month,
    year,

    totalDays: workingInfo.totalDays,
    sundayCount: workingInfo.sundayCount,
    saturdayCount: workingInfo.saturdayCount,
    saturdayOff: workingInfo.saturdayOff,
    workingDays: workingInfo.workingDays,
    offDays: workingInfo.offDays,
    customDays: workingInfo.customDays,

    actualDays,

    baseSalary,
    salaryPerDay: Math.round(salaryPerDay),
    salaryByDay,

    responsibilityCoef,
    responsibilityBase,
    responsibility,

    mealPerDay,
    meal,

    allowance: Number(input.allowance || 0),
    businessFee: Number(input.businessFee || 0),
    bonus: Number(input.bonus || 0),
    overtime: Number(input.overtime || 0),
    upsell: Number(input.upsell || 0),

    extraCong,

    latePenalty: Number(input.latePenalty || 0),
    penalty: Number(input.penalty || 0),
    advance: Number(input.advance || 0),

    plus,
    minus,
    total: plus - minus,
  };
}

function getWorkingInfo(year, month, saturdayOff, override) {
  const totalDays = new Date(year, month, 0).getDate();

  let sundayCount = 0;
  let saturdayCount = 0;

  for (let day = 1; day <= totalDays; day++) {
    const w = new Date(year, month - 1, day).getDay();

    if (w === 0) sundayCount++;
    else if (w === 6) saturdayCount++;
  }

  const auto = saturdayOff
    ? totalDays - sundayCount - saturdayCount
    : totalDays - sundayCount;

  const ov = Number(override || 0);
  const useOverride = ov > 0 && ov <= totalDays && ov !== auto;
  const workingDays = useOverride ? ov : auto;

  return {
    totalDays,
    sundayCount,
    saturdayCount,
    saturdayOff: Boolean(saturdayOff),
    workingDays,
    offDays: totalDays - workingDays,
    customDays: useOverride,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatSalaryResult(r) {
  const sep = "━━━━━━━━━━━━━━━━━━━";
  const L = [];

  L.push(sep);
  L.push(`<b>💰 BẢNG LƯƠNG THÁNG ${pad2(r.month)}/${r.year}</b>`);
  L.push(sep);

  L.push("<b>🗓 KỲ LƯƠNG</b>");
  L.push(
    `01/${pad2(r.month)}/${r.year} — ${r.totalDays}/${pad2(r.month)}/${r.year}`
  );

  L.push("<b>📅 NGÀY CÔNG</b>");
  L.push(`• Số ngày trong tháng: <b>${r.totalDays} ngày</b>`);

  if (r.customDays) {
    L.push(`• Ngày nghỉ: <b>${r.offDays} ngày</b> (tự ấn định)`);
  } else if (r.saturdayOff) {
    L.push(
      `• Ngày nghỉ tuần: <b>${r.sundayCount} CN + ${r.saturdayCount} T7</b>`
    );
  } else {
    L.push(`• Ngày chủ nhật: <b>${r.sundayCount} ngày</b>`);
  }

  L.push(`• Ngày làm việc: <b>${r.workingDays} ngày</b>`);
  L.push(`• Ngày công thực tế: <b>${r.actualDays} ngày</b>`);

  L.push("<b>💵 CĂN CỨ TÍNH LƯƠNG</b>");
  L.push(`• Lương cơ bản / tháng: <b>${fmt(r.baseSalary)}</b>`);
  L.push(`• Lương / ngày: <b>${fmt(r.salaryPerDay)}</b>`);

  if (r.responsibilityCoef) {
    L.push(
      `• Hệ số trách nhiệm: <b>${r.responsibilityCoef}</b> × lương ngày công ${fmt(
        r.responsibilityBase
      )}`
    );
  }

  if (r.mealPerDay) {
    L.push(`• Tiền ăn 1 buổi: <b>${fmt(r.mealPerDay)}</b>`);
  }

  L.push("<b>➕ CÁC KHOẢN CỘNG</b>");
  L.push(
    `• Lương ngày công (${r.actualDays} ngày): <b>${fmt(r.salaryByDay)}</b>`
  );

  if (r.responsibility) {
    L.push(`• Phụ cấp trách nhiệm: <b>${fmt(r.responsibility)}</b>`);
  }

  if (r.meal) {
    L.push(`• Tiền ăn (${r.actualDays} buổi): <b>${fmt(r.meal)}</b>`);
  }

  if (r.allowance) L.push(`• Trợ cấp: <b>${fmt(r.allowance)}</b>`);
  if (r.businessFee) L.push(`• Công tác phí: <b>${fmt(r.businessFee)}</b>`);
  if (r.bonus) L.push(`• Thưởng nóng: <b>${fmt(r.bonus)}</b>`);
  if (r.overtime) L.push(`• Tăng ca: <b>${fmt(r.overtime)}</b>`);
  if (r.upsell) L.push(`• Upsell: <b>${fmt(r.upsell)}</b>`);

  if (r.extraCong && r.extraCong.length) {
    r.extraCong.forEach((item) => {
      if (Number(item.value || 0) > 0) {
        L.push(`• ${escapeHtml(item.name)}: <b>${fmt(item.value)}</b>`);
      }
    });
  }

  L.push(`▸ <b>Tổng thu nhập: ${fmt(r.plus)}</b>`);

  L.push("<b>➖ CÁC KHOẢN TRỪ</b>");

  if (r.minus > 0) {
    if (r.latePenalty) L.push(`• Đi muộn: <b>${fmt(r.latePenalty)}</b>`);
    if (r.penalty) L.push(`• Phạt: <b>${fmt(r.penalty)}</b>`);
    if (r.advance) L.push(`• Ứng lương: <b>${fmt(r.advance)}</b>`);
  } else {
    L.push("• Không có khoản trừ");
  }

  L.push(`▸ <b>Tổng khoản trừ: ${fmt(r.minus)}</b>`);

  L.push(sep);
  L.push(`✅ <b>THỰC NHẬN: ${fmt(r.total)}</b>`);
  L.push(sep);
  L.push(`<i>🕒 Lập lúc ${nowVN()}</i>`);
  L.push("<i>🤖 Bot tính lương</i>");

  return L.join("\n");
}

/* ===================== TIỆN ÍCH ===================== */

function parseMoney(raw) {
  if (raw == null) return 0;

  let s = String(raw)
    .toLowerCase()
    .trim()
    .replace(/₫|vnd|đ/g, "")
    .replace(/\s+/g, "");

  if (!s) return 0;

  s = s
    .replace(/triệu|trieu|tr|m/g, "tr")
    .replace(/nghìn|nghin|ngàn|ngan|k/g, "k");

  let m = s.match(/^(\d+(?:[.,]\d+)?)tr(\d{1,3})?$/);
  if (m) {
    const base = parseFloat(m[1].replace(",", ".")) * 1000000;
    let tail = m[2] || "";
    while (tail && tail.length < 3) tail += "0";
    return Math.round(base + (tail ? parseInt(tail, 10) * 1000 : 0));
  }

  m = s.match(/^(\d+(?:[.,]\d+)?)k$/);
  if (m) {
    return Math.round(parseFloat(m[1].replace(",", ".")) * 1000);
  }

  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
    return parseInt(s.replace(/[.,]/g, ""), 10);
  }

  if (/^\d+([.,]\d+)?$/.test(s)) {
    return Math.round(parseFloat(s.replace(",", ".")));
  }

  return 0;
}

function parseNumber(raw) {
  if (raw == null) return 0;

  const s = String(raw).trim().replace(",", ".");
  if (!s) return 0;

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function getCurrentMonthVN() {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Bangkok",
      month: "numeric",
    }).format(new Date())
  );
}

function getCurrentYearVN() {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
    }).format(new Date())
  );
}

function nowVN() {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (t) => (p.find((x) => x.type === t) || {}).value || "";

  return `${get("hour")}:${get("minute")} ${get("day")}/${get("month")}/${get("year")}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmt(n) {
  return `${new Intl.NumberFormat("vi-VN").format(Math.round(n || 0))} ₫`;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

async function setMenuButton(env) {
  if (!env.BOT_TOKEN || !env.MINI_APP_URL) {
    console.log("Cannot set menu button: missing BOT_TOKEN or MINI_APP_URL");
    return;
  }

  const apiUrl =
    "https://api.telegram.org/bot" + env.BOT_TOKEN + "/setChatMenuButton";

  const payload = {
    menu_button: {
      type: "web_app",
      text: "Tính lương",
      web_app: {
        url: env.MINI_APP_URL,
      },
    },
  };

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log("setChatMenuButton status:", res
