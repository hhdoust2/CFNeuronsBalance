import { Bot, InlineKeyboard } from "grammy";

// ==========================================
// تنظیمات پیش‌فرض
// ==========================================
// آدرس API پیش‌فرض برای دریافت موجودی «نورون»های Workers AI
// اگر کلادفلر آدرس را عوض کند، آن را با Secret با نام NEURONS_API_URL بازنویسی کنید.
// در الگو، توکن {account_id} با شناسه‌ی حساب جایگزین می‌شود.
const DEFAULT_NEURONS_API_URL =
  "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/workers-ai/usage";
const FETCH_TIMEOUT = 30000;
const MAX_NAME_LEN = 32;
const ACCOUNT_NAME_RE = /^[A-Za-z0-9_\-]+$/;

// ==========================================
// ۱. رمزنگاری (AES-GCM با کلید مشتق‌شده از ENCRYPTION_KEY)
// ==========================================
async function deriveKey(secret, usage) {
  if (!secret) {
    throw new Error(
      "ENCRYPTION_KEY تنظیم نشده است. بدون این مقدار امکان رمزنگاری امن وجود ندارد."
    );
  }
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("cf-bot-accounts-key-v1") },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function encryptText(plainText, secretKey) {
  if (!plainText) return "";
  const key = await deriveKey(secretKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plainText)
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64(combined);
}

async function decryptText(cipherText, secretKey) {
  if (!cipherText) return "";
  try {
    const key = await deriveKey(secretKey, "decrypt");
    const data = base64ToBytes(cipherText);
    const iv = data.slice(0, 12);
    const encrypted = data.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encrypted
    );
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    console.error("decryptText failed:", err.message);
    return null;
  }
}

// ==========================================
// ۲. Fetch با Timeout
// ==========================================
async function fetchWithTimeout(url, options, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    if (error.name === "AbortError") {
      throw new Error(
        `زمان پاسخ‌دهی سرور بیش از حد طول کشید (بیش از ${Math.round(timeout / 1000)} ثانیه).`
      );
    }
    throw error;
  }
}

// ==========================================
// ۳. ذخیره‌ی حساب‌ها در KV (رمزنگاری‌شده)
// ==========================================
async function loadAccounts(env, userId) {
  const raw = await env.ACCOUNTS.get(`owner:${userId}:accounts`);
  if (!raw) return new Map();
  const dec = await decryptText(raw, env.ENCRYPTION_KEY);
  if (dec === null) {
    throw new Error("رمزگشایی حساب‌ها ناموفق بود (آیا ENCRYPTION_KEY عوض شده؟).");
  }
  return new Map(Object.entries(JSON.parse(dec)));
}

async function saveAccounts(env, userId, map) {
  const obj = Object.fromEntries(map);
  const enc = await encryptText(JSON.stringify(obj), env.ENCRYPTION_KEY);
  await env.ACCOUNTS.put(`owner:${userId}:accounts`, enc);
}

function validateAccountName(name) {
  if (!name || typeof name !== "string") return "نام حساب را بنویسید.";
  if (name.length > MAX_NAME_LEN) return `نام حساب حداکثر ${MAX_NAME_LEN} کاراکتر باشد.`;
  if (!ACCOUNT_NAME_RE.test(name))
    return "نام حساب فقط حروف انگلیسی، عدد، خط تیره یا زیرخط باشد.";
  return null;
}

// ==========================================
// ۴. دریافت موجودی نورون کار کلادفلر
// ==========================================
function guessNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^\d.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function collectNumbers(obj, out) {
  if (Array.isArray(obj)) {
    obj.forEach((o) => collectNumbers(o, out));
    return out;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (/neuron|remaining|balance|quota|credits/i.test(k)) {
        const n = guessNumber(v);
        if (n !== null) out.push({ key: k, value: n });
      }
      collectNumbers(v, out);
    }
  }
  return out;
}

function pickBest(found) {
  // ترجیح کلیدهای مشخص‌تر
  const priority = (k) =>
    /^remaining_neurons$/i.test(k) ? 4
    : /neuron/i.test(k) ? 3
    : /remaining/i.test(k) ? 2
    : /quota|credits/i.test(k) ? 1
    : 0;
  found.sort((a, b) => priority(b.key) - priority(a.key) || b.value - a.value);
  return found[0];
}

async function fetchNeuronsBalance(accountId, token, env) {
  const template = env.NEURONS_API_URL || DEFAULT_NEURONS_API_URL;
  const url = template.replace("{account_id}", encodeURIComponent(accountId));
  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const found = collectNumbers(body?.result ?? body, []);
  if (!found.length) throw new Error("پاسخ API قابل فهم نبود.");
  const best = pickBest(found);
  return { value: best.value, unit: best.key };
}

// ==========================================
// ۵. توابع کمکی رابط کاربری
// ==========================================
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function fmtNumber(n) {
  return Math.round(n * 100) / 100;
}

function mainMenuKeyboard() {
  return new InlineKeyboard()
    .text("💰 موجودی", "balance")
    .text("📋 لیست حساب‌ها", "list_accounts")
    .row()
    .text("➕ افزودن حساب", "help_add")
    .text("🗑 حذف حساب", "help_del");
}

function isAdmin(ctx) {
  if (ctx.chat?.type !== "private") return false;
  if (!ctx.env.ADMIN_ID) return false;
  return String(ctx.from.id) === String(ctx.env.ADMIN_ID);
}

function accountLine(name, data) {
  return `<b>${escHtml(name)}</b> — شناسه: <code>${escHtml(data.account_id)}</code> (${data.api_token ? "توکن ثبت شده" : "بدون توکن"})`;
}

// ==========================================
// ۶. شبکه‌کننده‌ی دستورها و دکمه‌ها
// ==========================================
function registerHandlers(bot) {
  // ---------- /start ----------
  bot.command("start", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("⛔ این ربات فقط برای ادمین است.");
    }
    await ctx.reply(
      "👋 خوش آمدید!\n\nاین ربات موجودی <b>نورون</b>های Workers AI چند حساب کلادفلر را نشان می‌دهد.\n\n" +
        "• با <code>/addaccount نام شناسه_حساب توکن_آپی</code> یک حساب اضافه کنید.\n" +
        "• با دکمه «💰 موجودی» موجودی همه‌ی حساب‌ها را ببینید.",
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
    );
  });

  bot.command("help", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.reply(
      "📖 <b>راهنما</b>\n\n" +
        "<code>/addaccount نام account_id api_token</code> — افزودن/به‌روزرسانی حساب\n" +
        "<code>/delaccount نام</code> — حذف یک حساب\n" +
        "<code>/accounts</code> — لیست حساب‌های ثبت‌شده\n" +
        "<code>/balance</code> — نمایش موجودی نورون همه‌ی حساب‌ها\n" +
        "<code>/reset</code> — پاک کردن همه‌ی حساب‌ها\n" +
        "<code>/help</code> — این راهنما",
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
    );
  });

  // ---------- /addaccount ----------
  bot.command("addaccount", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    // [0]=/addaccount
    if (parts.length < 4) {
      return ctx.reply(
        "✳️ فرمت درست:\n<code>/addaccount نام account_id api_token</code>",
        { parse_mode: "HTML" }
      );
    }
    const name = parts[1];
    const err = validateAccountName(name);
    if (err) return ctx.reply(`❌ ${err}`);
    const accountId = parts[2];
    const apiToken = parts[3];
    if (!accountId || !apiToken) {
      return ctx.reply("❌ account_id و api_token هر دو الزامی‌اند.");
    }
    try {
      const accounts = await loadAccounts(ctx.env, ctx.from.id);
      accounts.set(name, { account_id: accountId, api_token: apiToken });
      await saveAccounts(ctx.env, ctx.from.id, accounts);
      await ctx.reply(
        `✅ حساب <b>${escHtml(name)}</b> ذخیره شد (${accounts.size} حساب کل).`,
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
      );
    } catch (e) {
      await ctx.reply(`❌ خطا: ${e.message}`);
    }
  });

  // ---------- /delaccount ----------
  bot.command("delaccount", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const name = (ctx.message?.text || "").trim().split(/\s+/)[1];
    if (!name) {
      return ctx.reply("✳️ فرمت:\n<code>/delaccount نام</code>", {
        parse_mode: "HTML",
      });
    }
    try {
      const accounts = await loadAccounts(ctx.env, ctx.from.id);
      if (!accounts.has(name)) {
        return ctx.reply(`❌ حسابی با نام <b>${escHtml(name)}</b> یافت نشد.`, {
          parse_mode: "HTML",
        });
      }
      accounts.delete(name);
      await saveAccounts(ctx.env, ctx.from.id, accounts);
      await ctx.reply(`🗑 حساب <b>${escHtml(name)}</b> حذف شد.`, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard(),
      });
    } catch (e) {
      await ctx.reply(`❌ خطا: ${e.message}`);
    }
  });

  // ---------- /accounts ----------
  bot.command("accounts", async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
      const accounts = await loadAccounts(ctx.env, ctx.from.id);
      if (!accounts.size) {
        await ctx.reply("📭 حسابی ثبت نشده است. از /addaccount استفاده کنید.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }
      const lines = [...accounts.entries()].map(([n, d]) => accountLine(n, d));
      await ctx.reply(`📋 <b>حساب‌های شما</b> (${accounts.size}):\n\n${lines.join("\n")}`, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard(),
      });
    } catch (e) {
      await ctx.reply(`❌ خطا: ${e.message}`);
    }
  });

  // ---------- /reset ----------
  bot.command("reset", async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
      await ctx.env.ACCOUNTS.delete(`owner:${ctx.from.id}:accounts`);
      await ctx.reply("🔄 همه‌ی حساب‌ها پاک شد.", { reply_markup: mainMenuKeyboard() });
    } catch (e) {
      await ctx.reply(`❌ خطا: ${e.message}`);
    }
  });

  // ---------- /balance ----------
  async function runBalance(ctx) {
    let accounts;
    try {
      accounts = await loadAccounts(ctx.env, ctx.from.id);
    } catch (e) {
      return ctx.reply(`❌ خطا: ${e.message}`);
    }
    if (!accounts.size) {
      return ctx.reply("📭 حسابی ثبت نشده است. از /addaccount استفاده کنید.", {
        reply_markup: mainMenuKeyboard(),
      });
    }

    await ctx.reply("⏳ در حال دریافت موجودی نورون‌ها…");

    const results = [];
    for (const [name, data] of accounts.entries()) {
      try {
        const { value, unit } = await fetchNeuronsBalance(
          data.account_id,
          data.api_token,
          ctx.env
        );
        results.push(`✅ <b>${escHtml(name)}</b>: ${fmtNumber(value)} ${escHtml(unit)}`);
      } catch (e) {
        results.push(`❌ <b>${escHtml(name)}</b>: ${escHtml(e.message)}`);
      }
    }

    await ctx.reply(
      `💰 <b>موجودی نورون‌ها</b>\n\n${results.join("\n")}`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
    );
  }

  bot.command("balance", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await runBalance(ctx);
  });

  // ---------- دکمه‌های inline ----------
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => {});
    if (!isAdmin(ctx)) return;
    try {
      if (data === "balance") {
        await ctx.editMessageReplyMarkup({}).catch(() => {});
        await runBalance(ctx);
      } else if (data === "list_accounts") {
        const accounts = await loadAccounts(ctx.env, ctx.from.id);
        const body = accounts.size
          ? `📋 <b>حساب‌های شما</b> (${accounts.size}):\n\n` +
            [...accounts.entries()].map(([n, d]) => accountLine(n, d)).join("\n")
          : "📭 حسابی ثبت نشده است.";
        await ctx.editMessageText(body, {
          parse_mode: "HTML",
          reply_markup: mainMenuKeyboard(),
        }).catch(() => {});
      } else if (data === "help_add") {
        await ctx.editMessageText(
          "➕ <b>افزودن حساب</b>\n\n" +
            `فرمات:\n<code>/addaccount نام account_id api_token</code>\n\n` +
            "• نام: فقط حروف انگلیسی، عدد، خط تیره یا زیرخط\n" +
            "• account_id: شناسه‌ی حساب کلادفلر (از داشبورد)\n" +
            "• api_token: توکن API با دسترسی به Workers AI",
          { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
        ).catch(() => {});
      } else if (data === "help_del") {
        await ctx.editMessageText(
          "🗑 <b>حذف حساب</b>\n\n" +
            "فرمات:\n<code>/delaccount نام</code>",
          { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
        ).catch(() => {});
      }
    } catch (e) {
      await ctx.reply(`❌ خطا: ${e.message}`).catch(() => {});
    }
  });
}

// ==========================================
// ۷. اجرای Worker روی Cloudflare
// ==========================================
let cachedBotInfo = null;

async function getBot(env) {
  const bot = new Bot(env.BOT_TOKEN, cachedBotInfo ? { botInfo: cachedBotInfo } : undefined);
  bot.use(async (ctx, next) => {
    ctx.env = env;
    await next();
  });
  registerHandlers(bot);
  if (!cachedBotInfo) {
    await bot.init();
    cachedBotInfo = bot.botInfo;
    await bot.api
      .setMyCommands([
        { command: "start", description: "🏠 منوی اصلی" },
        { command: "balance", description: "💰 موجودی نورون‌ها" },
        { command: "accounts", description: "📋 لیست حساب‌ها" },
        { command: "addaccount", description: "➕ افزودن حساب" },
        { command: "delaccount", description: "🗑 حذف حساب" },
        { command: "reset", description: "🔄 پاک کردن همه‌ی حساب‌ها" },
        { command: "help", description: "📖 راهنما" },
      ])
      .catch((err) => console.error("setMyCommands failed:", err));
  }
  return bot;
}

export default {
  async fetch(request, env, ctx) {
    if (env.WEBHOOK_SECRET) {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }
    if (request.method !== "POST") {
      return new Response("OK");
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const bot = await getBot(env);
    ctx.waitUntil(
      bot.handleUpdate(update).catch((err) => console.error("handleUpdate error:", err))
    );
    return new Response("OK");
  },
};
