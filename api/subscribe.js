// api/subscribe.js — Email capture endpoint
// Validates email, logs it, and optionally sends via Resend if RESEND_API_KEY is set.
// Zero npm dependencies — pure Node built-ins.
'use strict';

const https = require('https');

// ── Rate limiting (in-memory, resets on cold start — acceptable for MVP) ──────
// Limits: 5 requests per IP per hour, 1 submission per email per 24h
const ipLimits    = new Map(); // ip    → { count, resetAt }
const emailSeen   = new Map(); // email → firstSeenAt

const IP_MAX      = 5;
const IP_WINDOW   = 3600 * 1000;        // 1 hour
const EMAIL_WINDOW = 24 * 3600 * 1000;  // 24 hours

function checkRateLimits(ip, email) {
  const now = Date.now();

  // Prune if maps grow large
  if (ipLimits.size > 500) {
    for (const [k, v] of ipLimits.entries()) { if (now > v.resetAt) ipLimits.delete(k); }
  }
  if (emailSeen.size > 2000) {
    for (const [k, v] of emailSeen.entries()) { if (now - v > EMAIL_WINDOW) emailSeen.delete(k); }
  }

  // IP check
  const ipEntry = ipLimits.get(ip) || { count: 0, resetAt: now + IP_WINDOW };
  if (now > ipEntry.resetAt) { ipEntry.count = 0; ipEntry.resetAt = now + IP_WINDOW; }
  ipEntry.count += 1;
  ipLimits.set(ip, ipEntry);
  if (ipEntry.count > IP_MAX) return { limited: true, reason: 'ip' };

  // Email dedup check
  const firstSeen = emailSeen.get(email);
  if (firstSeen && (now - firstSeen < EMAIL_WINDOW)) return { limited: true, reason: 'email' };
  emailSeen.set(email, now);

  return { limited: false };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) {
      if (typeof req.body === 'object') return resolve(req.body);
      if (typeof req.body === 'string') {
        try { return resolve(JSON.parse(req.body)); } catch { return reject(new Error('Invalid JSON')); }
      }
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', c => { raw += c; if (raw.length > 5000) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function isValidEmail(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return t.length >= 5 && t.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

// Sends a confirmation email via Resend (resend.com — 3,000 free emails/month)
function sendViaResend(apiKey, toEmail) {
  return new Promise((resolve, reject) => {
    const fromDomain = process.env.EMAIL_FROM_DOMAIN || 'convertmind.vercel.app';
    const fromAddress = `ConvertMind <hello@${fromDomain}>`;
    const body = JSON.stringify({
      from: fromAddress,
      to: [toEmail],
      subject: 'Your ConvertMind Analysis — Next Steps',
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e">
          <div style="background:#7B5CF6;padding:24px;border-radius:12px 12px 0 0">
            <h1 style="color:white;margin:0;font-size:20px">⚡ ConvertMind</h1>
          </div>
          <div style="background:#f9f9ff;padding:28px;border-radius:0 0 12px 12px;border:1px solid #e5e5f0">
            <h2 style="color:#7B5CF6">Thanks for using ConvertMind!</h2>
            <p>We've got your email and will send your full psychological analysis report shortly.</p>
            <p>In the meantime, here's what to do with your results:</p>
            <ol style="line-height:1.8;color:#4a4a6a">
              <li>Start with the <strong>HIGH severity</strong> weaknesses — they have the biggest revenue impact</li>
              <li>Implement the <strong>Week 1–2 Quick Wins</strong> first — they need no budget</li>
              <li>Re-run the analysis after you've made changes to track your score improvement</li>
            </ol>
            <p style="color:#888;font-size:13px;margin-top:24px">
              You're receiving this because you used ConvertMind's free analysis.
              <a href="#" style="color:#7B5CF6">Unsubscribe</a>
            </p>
          </div>
        </div>`,
    });

    const options = {
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(true);
        reject(new Error('Resend ' + res.statusCode + ': ' + data.slice(0, 120)));
      });
    });
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('Resend timeout')); });
    req.on('error', e => reject(new Error('Resend network: ' + e.message)));
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  // ── CORS origin check ────────────────────────────────────────────────────────
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  const requestOrigin = req.headers.origin || '';
  if (allowedOrigin !== '*' && requestOrigin && requestOrigin !== allowedOrigin) {
    return res.status(403).json({ error: true, message: 'Origin not allowed.' });
  }
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin === '*' ? '*' : requestOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Use POST.' });

  let body;
  try { body = await readBody(req); }
  catch (e) { return res.status(400).json({ error: true, message: 'Invalid request body.' }); }

  const email = (body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: true, message: 'Please enter a valid email address.' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const limitCheck = checkRateLimits(ip, email);
  if (limitCheck.limited) {
    const msg = limitCheck.reason === 'email'
      ? 'This email is already registered. Check your inbox!'
      : 'Too many requests. Please wait before trying again.';
    console.warn(`[CM Subscribe] Rate limited: ${ip} email=${email} reason=${limitCheck.reason}`);
    return res.status(429).json({ error: true, message: msg });
  }

  // Always log — your Vercel function logs are a free fallback email list
  console.log('[CM Subscribe]', email, new Date().toISOString());

  // Optional: Send confirmation via Resend
  const resendKey = process.env.RESEND_API_KEY;
  let emailSent = false;
  if (resendKey) {
    try {
      await sendViaResend(resendKey, email);
      emailSent = true;
      console.log('[CM Subscribe] Resend OK for', email);
    } catch (e) {
      // Non-fatal — email was captured even if delivery failed
      console.error('[CM Subscribe] Resend failed:', e.message);
    }
  }

  return res.status(200).json({
    success: true,
    message: emailSent
      ? 'Report sent! Check your inbox (and spam folder).'
      : 'Got it! We\'ll be in touch with tips to implement your results.',
  });
};
