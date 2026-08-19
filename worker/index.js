export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Telegram salary bot is running.");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const update = await request.json();

    try {
      await handleUpdate(update, env);
    } catch (err) {
      console.error("handleUpdate error:", err);
    }

    return new Response("OK");
  },
};

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (msg.web_app_data && msg.web_app_data.data) {
    return handleMiniAppData(chatId, msg.web_app_data.data, env);
  }

  if (text === "/start" || text.startsWith("/start@")) {
    return sendMessage(
      env,
      chatId,
      [
        "👋 Chào bạn!",
        "",
        "Mình là bot tính lương.",
        "",
        "Bạn có thể:",
        "1. Bấm nút Mini App để nhập bằng giao diện.",
        "2. Dùng lệnh /luongthang để nhận mẫu nhập liệu.",
        "",
        "Lệnh hỗ trợ:",
        "/luongthang",
        "/luongthang 7",
        "/luongthang07",
        "/help",
      ].join("\n"),
      miniAppKeyboard(env)
    );
  }

  if (text === "/help" || text.startsWith("/help@")) {
    return sendHelp(env, chatId);
  }

  if (isLuongThangCommand(text)) {
    const month = getMonthFromCommand(text);
    return sendSalaryTemplate(env, chatId, month);
  }

  if (looksLikeSalaryForm(text)) {
    const input = parseSalaryForm(text);
    const result = calculateSalary(input);
    return sendMessage(env, chatId, formatSalaryResult(result));
  }
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

async function sendHelp(env, chatId) {
  return sendMessage(
    env,
    chatId,
    [
      "📘 Hướng dẫn dùng bot tính lương",
      "",
      "Mở giao diện Mini App:",
      "Bấm nút bên dưới.",
      "",
      "Hoặc dùng lệnh:",
      "/luongthang",
      "/luongthang 7",
      "/luongthang07",
      "",
      "Bot sẽ gửi mẫu để bạn điền số liệu.",
      "",
      "Có thể nhập tiền dạng:",
      "9tr, 1tr2, 500k, 1200000, 1.200.000",
      "",
      "Dòng nào bỏ trống sẽ tính là 0.",
    ].join("\n"),
    miniAppKeyboard(env)
  );
}

async function sendSalaryTemplate(env, chatId, month) {
  const year = getCurrentYearVN();

  const text = [
    `📌 Mẫu tính lương tháng ${pad2(month)}/${year}`,
    "",
    "Copy mẫu dưới đây, điền số rồi gửi lại:",
    "",
    "```",
    `luongthang: ${month}`,
    "luong_co_ban:",
    "ngay_cong:",
    "he_so_trach_nhiem:",
    "muc_co_so_trach_nhiem:",
    "tien_an_1_buoi:",
    "tro_cap:",
    "cong_tac_phi:",
    "thuong_nong:",
    "tang_ca:",
    "upsell:",
    "di_muon:",
    "phat:",
    "ung_luong:",
    "",
    "# Khoản cộng bổ sung, có thể thêm nhiều dòng:",
    "cong_them: Tên khoản | Số tiền",
    "cong_them: Hoa hồng | 500k",
    "cong_them: Bonus dự án | 1tr",
    "```",
    "",
    "Ghi chú:",
    "- Có thể nhập: 9tr, 1tr2, 500k, 1200000, 1.200.000",
    "- Dòng nào bỏ trống sẽ tính là 0",
    "- Dòng cong_them có dạng: Tên khoản | Số tiền",
  ].join("\n");

  return sendMessage(env, chatId, text, miniAppKeyboard(env), "Markdown");
}

function looksLikeSalaryForm(text) {
  return /luongthang\s*:/i.test(text) || /luong_co_ban\s*:/i.test(text);
}

function parseSalaryForm(text) {
  const map = {};
  const extraCong = [];

  text.split("\n").forEach((line) => {
    const rawLine = line.trim();
    if (!rawLine || rawLine.startsWith("#")) return;

    const idx = rawLine.indexOf(":");
    if (idx === -1) return;

    const key = rawLine.slice(0, idx).trim().toLowerCase();
    const value = rawLine.slice(idx + 1).trim();

    if (key === "cong_them") {
      const parts = value.split("|");
      const name = (parts[0] || "Khoản cộng khác").trim();
      const amount = parseMoney(parts[1] || "");

      if (amount > 0) {
        extraCong.push({
          name,
          value: amount,
        });
      }

      return;
    }

    map[key] = value;
  });

  return {
    month: parseNumber(map.luongthang) || getCurrentMonthVN(),

    baseSalary: parseMoney(map.luong_co_ban) || 0,
    actualDays: parseNumber(map.ngay_cong) || 0,

    responsibilityCoef: parseNumber(map.he_so_trach_nhiem) || 0,
    responsibilityBase: parseMoney(map.muc_co_so_trach_nhiem) || 0,

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

  const input = {
    month: Number(data.month || getCurrentMonthVN()),

    baseSalary: Number(data.baseSalary || data.lcb || 0),
    actualDays: Number(data.actualDays || data.nc || 0),

    responsibilityCoef: Number(data.responsibilityCoef || data.hs || 0),
    responsibilityBase: Number(data.responsibilityBase || data.mcs || 0),

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

  const result = calculateSalary(input);
  return sendMessage(env, chatId, formatSalaryResult(result));
}

function calculateSalary(input) {
  const year = getCurrentYearVN();
  const workingInfo = getWorkingInfo(year, input.month);

  const baseSalary = input.baseSalary || 0;
  const actualDays = input.actualDays || 0;

  const salaryPerDay =
    workingInfo.workingDays > 0 ? baseSalary / workingInfo.workingDays : 0;

  const salaryByDay = Math.round(salaryPerDay * actualDays);

  const responsibilityBase = input.responsibilityBase || baseSalary;
  const responsibility = Math.round(
    responsibilityBase * (input.responsibilityCoef || 0)
  );

  const meal = Math.round((input.mealPerDay || 0) * actualDays);

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
    workingDays: workingInfo.workingDays,

    actualDays,

    salaryPerDay: Math.round(salaryPerDay),
    salaryByDay,
    responsibility,
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

function getWorkingInfo(year, month) {
  const totalDays = new Date(year, month, 0).getDate();
  let sundayCount = 0;

  for (let day = 1; day <= totalDays; day++) {
    const d = new Date(year, month - 1, day);
    if (d.getDay() === 0) sundayCount++;
  }

  return {
    totalDays,
    sundayCount,
    workingDays: totalDays - sundayCount,
  };
}

function formatSalaryResult(r) {
  const lines = [
    `💰 Bảng lương tháng ${pad2(r.month)}/${r.year}`,
    "",
    `📅 ${r.workingDays} ngày làm việc`,
    `${r.sundayCount} ngày chủ nhật · ${r.totalDays} ngày trong tháng`,
    `Ngày công thực tế: ${r.actualDays}`,
    "",
    `Lương/ngày: ${fmt(r.salaryPerDay)}`,
    `Lương ngày công: ${fmt(r.salaryByDay)}`,
  ];

  if (r.responsibility) lines.push(`Trách nhiệm: ${fmt(r.responsibility)}`);
  if (r.meal) lines.push(`Tiền ăn: ${fmt(r.meal)}`);
  if (r.allowance) lines.push(`Trợ cấp: ${fmt(r.allowance)}`);
  if (r.businessFee) lines.push(`Công tác phí: ${fmt(r.businessFee)}`);
  if (r.bonus) lines.push(`Thưởng nóng: ${fmt(r.bonus)}`);
  if (r.overtime) lines.push(`Tăng ca: ${fmt(r.overtime)}`);
  if (r.upsell) lines.push(`Upsell: ${fmt(r.upsell)}`);

  if (r.extraCong && r.extraCong.length) {
    lines.push("");
    lines.push("Khoản cộng bổ sung:");
    r.extraCong.forEach((item) => {
      if (Number(item.value || 0) > 0) {
        lines.push(`+ ${item.name}: ${fmt(item.value)}`);
      }
    });
  }

  const hasMinus = r.latePenalty || r.penalty || r.advance;
  if (hasMinus) {
    lines.push("");
    lines.push("Khoản trừ:");
    if (r.latePenalty) lines.push(`- Đi muộn: ${fmt(r.latePenalty)}`);
    if (r.penalty) lines.push(`- Phạt: ${fmt(r.penalty)}`);
    if (r.advance) lines.push(`- Ứng lương: ${fmt(r.advance)}`);
  }

  lines.push("");
  lines.push(`✅ Thực nhận dự kiến: ${fmt(r.total)}`);

  return lines.join("\n");
}

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
    const base = parseFloat(m[1].replace(",", ".")) * 1_000_000;
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

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmt(n) {
  return `${new Intl.NumberFormat("vi-VN").format(Math.round(n || 0))} ₫`;
}

async function sendMessage(env, chatId, text, replyMarkup, parseMode) {
  const payload = {
    chat_id: chatId,
    text,
  };

  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (parseMode) payload.parse_mode = parseMode;

  const url = "https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.log(await res.text());
  }
}
