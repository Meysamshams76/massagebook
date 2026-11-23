// _worker.js — Cloudflare Pages Functions
// Secrets لازم در Settings > Environment variables:
//   ADMIN_PASSWORD, JWT_SECRET, ZARINPAL_MERCHANT, SITE_URL
// Binding دیتابیس: DB (نوع D1)
// اختیاری برای اعلان تلگرام: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

const PRICES = { swedish: 1000000, relax: 900000 };
const DEPOSIT_RATE = 0.20;
const PENDING_GRACE_MIN = 15;   // دقیقه‌ای که یک رزرو pending اسلات را قفل می‌کند
const LOGIN_LOCK_MIN = 15;
const LOGIN_MAX_ATTEMPTS = 5;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const origin = request.headers.get('Origin') || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      // ============ ایجاد پرداخت ============
      if (path === '/api/create-payment' && method === 'POST') {
        return await handleCreatePayment(request, env, cors);
      }

      // ============ بازگشت از درگاه ============
      if (path === '/api/verify' && method === 'GET') {
        return await handleVerify(url, env, cors);
      }

      // ============ ورود مدیر ============
      if (path === '/api/admin/login' && method === 'POST') {
        return await handleLogin(request, env, cors);
      }

      // ============ دریافت رزروها (محافظت‌شده) ============
      if (path === '/api/admin/bookings' && method === 'GET') {
        if (!await verifyToken(request, env.JWT_SECRET)) {
          return json({ message: 'unauthorized' }, 401, cors);
        }
        const { results } = await env.DB.prepare(
          `SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500`
        ).all();
        return json({ bookings: results }, 200, cors);
      }

      // ============ تغییر وضعیت رزرو (محافظت‌شده) ============
      if (path.startsWith('/api/admin/bookings/') && method === 'PATCH') {
        if (!await verifyToken(request, env.JWT_SECRET)) {
          return json({ message: 'unauthorized' }, 401, cors);
        }
        const id = parseInt(path.split('/').pop(), 10);
        if (!Number.isInteger(id) || id < 1) {
          return json({ message: 'شناسه نامعتبر' }, 400, cors);
        }
        const { status } = await request.json();
        if (!['paid', 'pending', 'cancelled'].includes(status)) {
          return json({ message: 'وضعیت نامعتبر' }, 400, cors);
        }
        await env.DB.prepare(`UPDATE bookings SET status=? WHERE id=?`)
          .bind(status, id).run();
        return json({ ok: true }, 200, cors);
      }

      // ============ سرو فایل‌های استاتیک ============
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Worker error:', err.stack || err);
      return json({ message: 'خطای داخلی سرور' }, 500, cors);
    }
  }
};

// ==================================================
// ایجاد پرداخت
// ==================================================
async function handleCreatePayment(request, env, cors) {
  let body;
  try { body = await request.json(); }
  catch { return json({ message: 'بدنه درخواست نامعتبر' }, 400, cors); }

  const type = String(body.type || '');
  const duration = parseInt(body.duration, 10);
  const date = String(body.date || '').trim();
  const time = String(body.time || '').trim();
  const name = String(body.name || '').trim().slice(0, 80);
  const phone = normalizePhone(body.phone);

  // --- اعتبارسنجی ---
  if (!PRICES[type]) return json({ message: 'نوع ماساژ نامعتبر' }, 400, cors);
  if (!Number.isInteger(duration) || duration < 1 || duration > 8)
    return json({ message: 'مدت زمان نامعتبر' }, 400, cors);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return json({ message: 'تاریخ نامعتبر' }, 400, cors);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    return json({ message: 'ساعت نامعتبر' }, 400, cors);
  if (name.length < 3) return json({ message: 'نام نامعتبر' }, 400, cors);
  if (!/^09\d{9}$/.test(phone))
    return json({ message: 'شماره موبایل نامعتبر (مثال: ۰۹۱۲۳۴۵۶۷۸۹)' }, 400, cors);

  // تاریخ نباید گذشته باشد
  const today = new Date().toISOString().split('T')[0];
  if (date < today) return json({ message: 'تاریخ نمی‌تواند در گذشته باشد' }, 400, cors);

  // ساعت باید بین ۱۰ تا ۲۲ باشد (با احتساب مدت)
  const startHour = parseInt(time.split(':')[0], 10);
  if (startHour < 10 || startHour + duration > 22)
    return json({ message: 'ساعت انتخابی خارج از ساعات کاری است' }, 400, cors);

  // --- بررسی رزرو تکراری ---
  const existing = await env.DB.prepare(
    `SELECT id FROM bookings
     WHERE booking_date=? AND booking_time=?
       AND (
         status='paid'
         OR (status='pending' AND datetime(created_at) > datetime('now', ?))
       )
     LIMIT 1`
  ).bind(date, time, `-${PENDING_GRACE_MIN} minutes`).first();

  if (existing) {
    return json({ message: 'این زمان قبلاً رزرو شده یا در حال پرداخت است' }, 409, cors);
  }

  // آزادسازی خودکار رزروهای pending منقضی روی همان اسلات
  await env.DB.prepare(
    `UPDATE bookings SET status='cancelled'
     WHERE booking_date=? AND booking_time=? AND status='pending'
       AND datetime(created_at) <= datetime('now', ?)`
  ).bind(date, time, `-${PENDING_GRACE_MIN} minutes`).run();

  // --- محاسبه مبلغ در سرور (مهم‌ترین لایه امنیتی) ---
  const totalAmount = PRICES[type] * duration;
  const depositAmount = Math.round(totalAmount * DEPOSIT_RATE);

  // --- درج رزرو ---
  let bookingId;
  try {
    const insert = await env.DB.prepare(
      `INSERT INTO bookings
       (name, phone, massage_type, duration, booking_date, booking_time,
        total_amount, deposit_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(name, phone, type, duration, date, time, totalAmount, depositAmount).run();
    bookingId = insert.meta.last_row_id;
  } catch (err) {
    console.error('Insert error:', err);
    return json({ message: 'خطا در ثبت رزرو' }, 500, cors);
  }

  // --- درخواست به زرین‌پال ---
  try {
    const zpRes = await fetch('https://payment.zarinpal.com/pg/v4/payment/request.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        merchant_id: env.ZARINPAL_MERCHANT,
        amount: depositAmount,
        currency: 'IRT',
        description: `بیعانه رزرو #${bookingId} - ${name}`,
        callback_url: `${env.SITE_URL}/api/verify`,
        metadata: { mobile: phone }
      })
    });
    const zpData = await zpRes.json();

    if (zpData?.data?.code === 100 && zpData.data.authority) {
      // ذخیره authority برای verify امن
      await env.DB.prepare(`UPDATE bookings SET authority=? WHERE id=?`)
        .bind(zpData.data.authority, bookingId).run();

      return json({
        paymentUrl: `https://payment.zarinpal.com/pg/StartPay/${zpData.data.authority}`
      }, 200, cors);
    }

    // شکست درگاه → لغو رزرو
    console.error('ZarinPal request failed:', JSON.stringify(zpData));
    await env.DB.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`)
      .bind(bookingId).run();
    return json({ message: 'درگاه پرداخت در دسترس نیست. لطفاً بعداً تلاش کنید.' }, 502, cors);
  } catch (err) {
    console.error('ZarinPal network error:', err);
    await env.DB.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`)
      .bind(bookingId).run();
    return json({ message: 'خطا در ارتباط با درگاه پرداخت' }, 502, cors);
  }
}

// ==================================================
// تأیید پرداخت (بازگشت از درگاه)
// ==================================================
async function handleVerify(url, env, cors) {
  const authority = url.searchParams.get('Authority');
  const status = url.searchParams.get('Status');

  if (status !== 'OK' || !authority) {
    return htmlRedirect(`${env.SITE_URL}/?payment=failed`);
  }

  // رزرو را با authority پیدا کن (نه با booking_id قابل دستکاری)
  const booking = await env.DB.prepare(
    `SELECT id, deposit_amount, status FROM bookings WHERE authority=? LIMIT 1`
  ).bind(authority).first();

  if (!booking) return htmlRedirect(`${env.SITE_URL}/?payment=error`);

  // Idempotent: اگر قبلاً پرداخت شده، دوباره success بده
  if (booking.status === 'paid') {
    return htmlRedirect(`${env.SITE_URL}/?payment=success`);
  }

  if (booking.status === 'cancelled') {
    return htmlRedirect(`${env.SITE_URL}/?payment=error`);
  }

  try {
    const verifyRes = await fetch('https://payment.zarinpal.com/pg/v4/payment/verify.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        merchant_id: env.ZARINPAL_MERCHANT,
        amount: booking.deposit_amount,
        authority
      })
    });
    const vData = await verifyRes.json();

    // کد 100 = تأیید موفق، 101 = قبلاً تأیید شده
    if (vData?.data && (vData.data.code === 100 || vData.data.code === 101)) {
      await env.DB.prepare(`UPDATE bookings SET status='paid' WHERE id=?`)
        .bind(booking.id).run();

      // اعلان تلگرام (اختیاری)
      notifyTelegram(env, booking.id, authority);

      return htmlRedirect(`${env.SITE_URL}/?payment=success`);
    }

    console.error('ZarinPal verify failed:', JSON.stringify(vData));
    return htmlRedirect(`${env.SITE_URL}/?payment=failed`);
  } catch (err) {
    console.error('Verify network error:', err);
    return htmlRedirect(`${env.SITE_URL}/?payment=error`);
  }
}

// ==================================================
// ورود مدیر با rate limiting + constant-time compare
// ==================================================
async function handleLogin(request, env, cors) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // بررسی قفل
  try {
    const rec = await env.DB.prepare(
      `SELECT attempts, last_attempt FROM login_attempts WHERE ip=?`
    ).bind(ip).first();

    if (rec && rec.attempts >= LOGIN_MAX_ATTEMPTS) {
      const last = new Date(String(rec.last_attempt).replace(' ', 'T') + 'Z').getTime();
      const elapsedMin = (Date.now() - last) / 60000;
      if (elapsedMin < LOGIN_LOCK_MIN) {
        const remain = Math.ceil(LOGIN_LOCK_MIN - elapsedMin);
        return json({ message: `تلاش‌های ناموفق زیاد. ${remain} دقیقه صبر کنید.` }, 429, cors);
      }
      // زمان قفل گذشته، ریست کن
      await env.DB.prepare(`DELETE FROM login_attempts WHERE ip=?`).bind(ip).run();
    }
  } catch (err) {
    console.error('Rate-limit check error:', err);
    // در صورت خطا، ادامه بده (fail-open برای دسترسی مدیر)
  }

  let password = '';
  try { password = String((await request.json()).password || ''); }
  catch { return json({ message: 'بدنه نامعتبر' }, 400, cors); }

  const expected = env.ADMIN_PASSWORD || '';

  // مقایسه constant-time
  if (!constantTimeEqual(expected, password)) {
    try {
      await env.DB.prepare(
        `INSERT INTO login_attempts (ip, attempts, last_attempt)
         VALUES (?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(ip) DO UPDATE SET
           attempts = attempts + 1,
           last_attempt = CURRENT_TIMESTAMP`
      ).bind(ip).run();
    } catch (err) { console.error('Rate-limit write error:', err); }
    return json({ message: 'رمز عبور اشتباه' }, 401, cors);
  }

  // موفق → ریست شمارنده
  try {
    await env.DB.prepare(`DELETE FROM login_attempts WHERE ip=?`).bind(ip).run();
  } catch (err) { console.error('Rate-limit reset error:', err); }

  const token = await signToken(env.JWT_SECRET);
  return json({ token }, 200, cors);
}

// ==================================================
// ابزارها
// ==================================================
function json(obj, status, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

function htmlRedirect(url) {
  return new Response(null, {
    status: 302,
    headers: { Location: url, 'Cache-Control': 'no-store' }
  });
}

function normalizePhone(input) {
  const map = { '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9',
                '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
  return String(input || '')
    .split('').map(c => map[c] || c).join('')
    .replace(/\D/g, '');
}

function constantTimeEqual(a, b) {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// --- JWT ساده با HMAC-SHA256 ---
function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function signToken(secret) {
  const enc = new TextEncoder();
  const payloadBytes = enc.encode(JSON.stringify({
    role: 'admin',
    exp: Date.now() + 12 * 60 * 60 * 1000
  }));
  const payload = b64urlEncode(payloadBytes);

  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return payload + '.' + b64urlEncode(new Uint8Array(sig));
}

async function verifyToken(request, secret) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  try {
    const [payload, sigB64] = parts;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key, b64urlDecode(sigB64), enc.encode(payload)
    );
    if (!valid) return false;

    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (data.role !== 'admin') return false;
    if (typeof data.exp !== 'number' || Date.now() > data.exp) return false;
    return true;
  } catch {
    return false;
  }
}

// --- اعلان تلگرام (اختیاری) ---
async function notifyTelegram(env, bookingId, authority) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    const b = await env.DB.prepare(`SELECT * FROM bookings WHERE id=?`).bind(bookingId).first();
    if (!b) return;
    const text =
      `🎉 رزرو جدید پرداخت شد!\n\n` +
      `👤 ${b.name}\n` +
      `📞 ${b.phone}\n` +
      `💆 ${b.massage_type === 'swedish' ? 'سوئدی' : 'رلکسی'} — ${b.duration} ساعت\n` +
      `📅 ${b.booking_date} ساعت ${b.booking_time}\n` +
      `💰 کل: ${b.total_amount.toLocaleString('fa-IR')} ت\n` +
      `✅ بیعانه: ${b.deposit_amount.toLocaleString('fa-IR')} ت`;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text })
    });
  } catch (err) {
    console.error('Telegram notify failed:', err);
  }
}