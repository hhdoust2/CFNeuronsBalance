# 🤖 ربات تلگرامی موجودی «نورون»های کلادفلر (Workers AI)

رباتی که روی **Cloudflare Workers** اجرا می‌شود و موجودی «نورون» (Neurons) چند حساب کلادفلر را از داخل تلگرام نشان می‌دهد. حساب‌ها با دکمه / دستور در ربات ثبت می‌شوند و **رمزنگاری‌شده** در **KV** ذخیره می‌شوند.

## امکانات

- ➕ افزودن حساب با `account_id` و `api_token` (`/addaccount`)
- 📋 لیست حساب‌های ثبت‌شده (`/accounts`)
- 💰 دکمه/دستور **موجودی** — دریافت موجودی نورون همه‌ی حساب‌ها در یک پیام
- 🗑 حذف حساب (`/delaccount`) و ریست کامل (`/reset`)
- 🔒 فقط ادمین (بر اساس `ADMIN_ID`) دسترسی دارد
- 🔐 ذخیره‌ی امن و رمزنگاری‌شده در KV

## ساختار

```
cf-neurons-bot/
├── index.js          # کد اصلی ربات (Worker)
├── package.json
├── wrangler.toml     # تنظیمات ورکر + اتصال KV
└── README.md
```

## نصب و استقرار

### ۱. پیش‌نیازها
- [Node.js](https://nodejs.org) و [wrangler](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- توکن ربات تلگرام از [BotFather](https://t.me/BotFather) (دستور `/token`)
- شناسه‌ی عددی خودتان از [@userinfobot](https://t.me/userinfobot)
- یک حساب کلادفلر (برای ساخت فضای نام KV)

### ۲. نصب وابستگی‌ها
```bash
cd cf-neurons-bot
npm install
```

### ۳. ساخت فضای نام KV
```bash
wrangler kv namespace create ACCOUNTS
```
خروجی شامل `id` است؛ آن را در `wrangler.toml` جایگزین `REPLACE_WITH_NAMESPACE_ID` کنید.

### ۴. تنظیم Secretهای ورکر
```bash
wrangler secret put BOT_TOKEN          # توکن ربات
wrangler secret put ADMIN_ID           # شناسه‌ی عددی ادمین
wrangler secret put ENCRYPTION_KEY     # کلید رمزنگاری (یک رشته‌ی تصادفی طولانی)
```
اختیاری:
```bash
wrangler secret put WEBHOOK_SECRET     # امنیت وبهوک (پیشنهادی)
```

> توجه: اگر `ENCRYPTION_KEY` را بعداً عوض کنید، حساب‌های ذخیره‌شده قابل رمزگشایی نخواهند بود (باید دوباره ثبت شوند).

### ۵. استقرار
```bash
wrangler deploy
```
آدرس ورکر را کپی کنید (مثل `https://cf-neurons-bot.<your-subdomain>.workers.dev`).

### ۶. اتصال وبهوک تلگرام
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://cf-neurons-bot.<your-subdomain>.workers.dev/&secret_token=<WEBHOOK_SECRET>"
```

## استفاده

به ربات `/start` بزنید (فقط ادمین):

- **افزودن حساب**:
  ```
  /addaccount test 1234567890abcdef zhCb_xxxx...
  ```
  - نام: فقط حروف انگلیسی، عدد، `_` یا `-`
  - `account_id`: شناسه‌ی حساب کلادفلر
  - `api_token`: توکن API کلادفلر (راهنمای ساخت توکن مناسب در بخش «نکته درباره نحوه دریافت موجودی نورون»)
- **لیست حساب‌ها**: `/accounts`
- **حذف حساب**: `/delaccount test`
- **موجودی**: دکمه «💰 موجودی» یا دستور `/balance`

## نکته درباره نحوه دریافت موجودی نورون

ربات موجودی نورون را از **GraphQL Analytics** کلادفلر (`https://api.cloudflare.com/client/v4/graphql`) و با کوئری `aiInferenceAdaptiveGroups` دریافت می‌کند:
- فیلد جمع‌شده: `sum.totalNeurons`
- بازه: امروز (به وقت UTC) — هر روز ساعت ۰۰:۰۰ UTC ریست می‌شود
- نمایش: مصرف‌شده، سقف رایگان روزانه (۱۰٬۰۰۰)، باقیمانده و زمان ریست

### ساخت توکن API مناسب

تک در `/addaccount` باید یک **API Token سفارشی** با دسترسی به همان حساب باشد:

1. داشبورد کلادفلر ← **My Profile** ← **API Tokens** ← **Create Token** ← **Create Custom Token**.
2. مجوزها (Permissions):
   - **Permission:** `Account` → **Workers AI** → **Edit** (حداقل Read)
   - اگر خطای permission دریافت کردید، **Account Analytics / GraphQL Analytics** را نیز اضافه کنید (مجوز Read).
3. **Account Resources:** `Include` → همان حساب کلادفلر را انتخاب کنید (برای امنیت، به‌جای All accounts).
4. توکن ساخته‌شده را در `/addaccount` ثبت کنید.

> نکته: توکن باید دسترسی سطح **Account** (نه Zone) داشته باشد؛ اگر حساب شما چندگانه است، برای هر حساب توکن جداگانه‌ای با دسترسی به همان حساب بسازید.
