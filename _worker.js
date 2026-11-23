// _worker.js — Cloudflare Pages Functions
// Secrets لازم: ADMIN_PASSWORD, JWT_SECRET
// Binding دیتابیس: DB (نوع D1)

const PRICES = { swedish: 1000000, relax: 900000 };
const PENDING_GRACE_MIN = 15;

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
    };
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (path === '/api/create-booking' && method === 'POST') {
        return await handleCreateBooking(request, env, cors);
      }

      if (path === '/api/admin/login' && method === 'POST') {
        return await handleLogin(request, env, cors);
      }

      if (path === '/api/admin/bookings' && method === 'GET') {
        if (!await verifyToken(request, env.JWT_SECRET)) {
          return json({ message: 'unauthorized' }, 401, cors);
        }
        const { results } = await env.DB.prepare(
          `SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500`
        ).all();
        return json({ bookings: results }, 200, cors);
      }

      if (path.startsWith('/api/admin/bookings/') && method === 'PATCH') {
        if (!await verifyToken(request, env.JWT_SECRET)) {
          return json({ message: 'unauthorized' }, 401, cors);
        }
        const id = parseInt(path.split('/').pop(), 10);
        if (!Number.isInteger(id) || id < 1) return json({ message: 'شناسه نامعتبر' }, 400, cors);
        
        const { status } = await request.json();
        if (!['confirmed', 'pending', 'cancelled'].includes(status)) {
          return json({ message: 'وضعیت نامعتبر' }, 400, cors);
        }
        await env.DB.prepare(`UPDATE bookings SET status=? WHERE id=?`).bind(status, id).run();
        return json({ ok: true }, 200, cors);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Worker error:', err.stack || err);
      return json({ message: 'خطای داخلی سرور' }, 500, cors);
    }
  }
};

async function handleCreateBooking(request, env, cors) {
  let body;
  try { body = await request.json(); }
  catch { return json({ message: 'بدنه درخواست نامعتبر' }, 400, cors); }

  const type = String(body.type || '');
  const duration = parseInt(body.duration, 10);
  const date = String(body.date || '').trim();
  const time = String(body.time || '').trim();
  const name = String(body.name || '').trim().slice(0, 80);
  const phone = normalizePhone(body.phone);

  // اعتبارسنجی
  if (!PRICES[type]) return json({ message: 'نوع ماساژ نامعتبر' }, 400, cors);
  if (!Number.isInteger(duration) || duration < 1 || duration > 8) return json({ message: 'مدت زمان نامعتبر' }, 400, cors);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ message: 'تاریخ نامعتبر' }, 400, cors);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return json({ message: 'ساعت نامعتبر' }, 400, cors);
  if (name.length < 3) return json({ message: 'نام نامعتبر' }, 400, cors);
  if (!/^09\d{9}$/.test(phone)) return json({ message: 'شماره موبایل نامعتبر' }, 400, cors);

  const today = new Date().toISOString().split('T')[0];
  if (date < today) return json({ message: 'تاریخ نمی‌تواند در گذشته باشد' }, 400, cors);

  const startHour = parseInt(time.split(':')[0], 10);
  if (startHour < 10 || startHour + duration > 22) return json({ message: 'ساعت خارج از ساعات کاری' }, 400, cors);

  // چک رزرو تکراری
  const existing = await env.DB.prepare(
    `SELECT id FROM bookings WHERE booking_date=? AND booking_time=? AND (status='confirmed' OR (status='pending' AND datetime(created_at) > datetime('now', ?))) LIMIT 1`
  ).bind(date, time, `-${PENDING_GRACE_MIN} minutes`).first();

  if (existing) {
    return json({ message: 'این زمان قبلاً رزرو شده است. لطفاً زمان دیگری انتخاب کنید.' }, 409, cors);
  }

  // آزادسازی خودکار اسلات‌های منقضی
  await env.DB.prepare(
    `UPDATE bookings SET status='cancelled' WHERE booking_date=? AND booking_time=? AND status='pending' AND datetime(created_at) <= datetime('now', ?)`
  ).bind(date, time, `-${PENDING_GRACE_MIN} minutes`).run();

  const totalAmount = PRICES[type] * duration;

  try {
    await env.DB.prepare(
      `INSERT INTO bookings (name, phone, massage_type, duration, booking_date, booking_time, total_amount, deposit_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')`
    ).bind(name, phone, type, duration, date, time, totalAmount).run();

    return json({ success: true }, 201, cors);
  } catch (err) {
    console.error('Insert error:', err);
    return json({ message: 'خطا در ثبت رزرو' }, 500, cors);
  }
}

async function handleLogin(request, env, cors) {
  let password = '';
  try { password = String((await request.json()).password || ''); }
  catch { return json({ message: 'بدنه نامعتبر' }, 400, cors); }

  const expected = env.ADMIN_PASSWORD || '';
  if (!constantTimeEqual(expected, password)) {
    return json({ message: 'رمز عبور اشتباه' }, 401, cors);
  }

  const token = await signToken(env.JWT_SECRET);
  return json({ token }, 200, cors);
}

// ابزارها
function json(obj, status, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

function normalizePhone(input) {
  const map = { '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9',
                '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
  return String(input || '').split('').map(c => map[c] || c).join('').replace(/\D/g, '');
}

function constantTimeEqual(a, b) {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function b64urlEncode(bytes) {
  let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return bytes;
}
async function signToken(secret) {
  const enc = new TextEncoder();
  const payloadBytes = enc.encode(JSON.stringify({ role: 'admin', exp: Date.now() + 12 * 60 * 60 * 1000 }));
  const payload = b64urlEncode(payloadBytes);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return payload + '.' + b64urlEncode(new Uint8Array(sig));
}
async function verifyToken(request, secret) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim(); const parts = token.split('.');
  if (parts.length !== 2) return false;
  try {
    const [payload, sigB64] = parts; const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, b64urlDecode(sigB64), enc.encode(payload));
    if (!valid) return false;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (data.role !== 'admin' || typeof data.exp !== 'number' || Date.now() > data.exp) return false;
    return true;
  } catch { return false; }
}
