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
wrangler secret put NEURONS_API_URL     # فقط اگر آدرس API پیش‌فرض را تغییر دهید
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
  - `api_token`: توکن API کلادفلر (با دسترسی به Workers AI)
- **لیست حساب‌ها**: `/accounts`
- **حذف حساب**: `/delaccount test`
- **موجودی**: دکمه «💰 موجودی» یا دستور `/balance`

## نکته درباره آدرس API نورون
آدرس پیش‌فرض:
```
https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/workers-ai/usage
```
اگر کلادفلر این آدرس یا ساختار پاسخ را تغییر دهد:
- آدرس را از طریق Secret با نام `NEURONS_API_URL` (با جای‌نگهدار `{account_id}`) بازنویسی کنید.
- یا در `index.js` مقدار `DEFAULT_NEURONS_API_URL` را عوض کنید.

ربات به‌صورت هوشمند میدان‌های دارای کلیدهای `neuron` / `remaining` / `balance` / `quota` / `credits` را در پاسخ API پیدا می‌کند.
