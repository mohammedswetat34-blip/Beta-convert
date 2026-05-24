// api/analyze.js  —  Vercel Serverless Function
// Zero npm dependencies. Pure Node.js built-ins only.
'use strict';

const https = require('https');

// ── Simple in-memory cache (URL → {result, ts}) ──────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Simple rate limiter (ip → {count, resetAt}) ───────────────────────────────
const rateLimits = new Map();
const RATE_MAX = 15;          // requests per window
const RATE_WINDOW_MS = 3600000; // 1 hour window

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_WINDOW_MS; }
  entry.count += 1;
  rateLimits.set(ip, entry);
  return entry.count > RATE_MAX;
}

// Prune stale entries when maps get large (serverless-safe — no setInterval)
function pruneIfNeeded() {
  const now = Date.now();
  if (cache.size > 200) {
    for (const [k, v] of cache.entries()) { if (now - v.ts > CACHE_TTL_MS) cache.delete(k); }
  }
  if (rateLimits.size > 500) {
    for (const [k, v] of rateLimits.entries()) { if (now > v.resetAt) rateLimits.delete(k); }
  }
}

// ── Body reader ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) {
      if (typeof req.body === 'object') return resolve(req.body);
      if (typeof req.body === 'string') {
        try { return resolve(JSON.parse(req.body)); } catch { return reject(new Error('Body is not valid JSON')); }
      }
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; if (raw.length > 20000) { req.destroy(); reject(new Error('Request too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Body is not valid JSON')); } });
    req.on('error', reject);
  });
}

// ── Input validation ──────────────────────────────────────────────────────────
function validateUrl(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'A website URL is required.' };
  const t = raw.trim();
  if (t.length < 4 || t.length > 500) return { ok: false, error: 'URL must be 4–500 characters.' };
  let p;
  try { p = new URL(t); } catch { return { ok: false, error: 'Invalid URL. Make sure it starts with https://' }; }
  if (p.protocol !== 'https:' && p.protocol !== 'http:') return { ok: false, error: 'URL must start with https://' };
  return { ok: true, url: p.href };
}

function sanitise(s, n) {
  if (typeof s !== 'string') return '';
  return s.replace(/[^a-zA-Z0-9 &\-/.,]/g, '').trim().slice(0, n || 80);
}

// ── Anthropic API call ────────────────────────────────────────────────────────
function callAnthropic(apiKey, model, prompt) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
    const options = {
      hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        console.log(`[CM] Anthropic status: ${res.statusCode} model: ${model}`);
        let parsed;
        try { parsed = JSON.parse(data); } catch { return reject(Object.assign(new Error('Non-JSON Anthropic response'), { status: res.statusCode })); }
        if (res.statusCode === 200) return resolve(parsed);
        const msg = parsed?.error?.message || `HTTP ${res.statusCode}`;
        console.error(`[CM] Anthropic error (${res.statusCode}): ${msg}`);
        reject(Object.assign(new Error(msg), { status: res.statusCode }));
      });
    });
    // 8 second timeout — keeps well under Vercel hobby 10s limit
    req.setTimeout(8000, () => { req.destroy(); reject(Object.assign(new Error('Anthropic timed out (8s)'), { status: 408 })); });
    req.on('error', e => reject(Object.assign(new Error('Network error: ' + e.message), { status: 503 })));
    req.write(bodyStr);
    req.end();
  });
}

// ── Prompt ────────────────────────────────────────────────────────────────────
function buildPrompt(url, industry) {
  const domain = url.replace(/^https?:\/\//, '').split('/')[0];
  return `You are a senior CRO expert and consumer psychologist. Analyse ${url} (${domain}) for the ${industry} industry.

Apply: Cialdini 7 Principles, Cognitive Load Theory, Prospect Theory/Loss Aversion, Visual Hierarchy, Fogg Behavior Model, Pricing Psychology, CRO best practices.

Return ONLY a valid JSON object starting with { and ending with }. No markdown. No extra text.

{"siteName":"brand","overallScore":54,"overallGrade":"C+","overallSummary":"2-3 sentence honest assessment","scores":{"trustCredibility":50,"visualHierarchy":60,"conversionFunnel":42,"psychologicalTriggers":47,"messagingClarity":58,"mobileExperience":65},"weaknesses":[{"severity":"HIGH","title":"title","description":"psychological principle + specific observation"},{"severity":"HIGH","title":"title","description":"..."},{"severity":"MED","title":"title","description":"..."},{"severity":"MED","title":"title","description":"..."},{"severity":"LOW","title":"title","description":"..."}],"psychologicalAnalysis":[{"trigger":"Social Proof","issue":"specific finding for ${domain}"},{"trigger":"Scarcity / Urgency","issue":"..."},{"trigger":"Authority Signals","issue":"..."},{"trigger":"Loss Aversion","issue":"..."},{"trigger":"Cognitive Load","issue":"..."},{"trigger":"Reciprocity","issue":"..."}],"improvementPlan":[{"phase":"WEEK 1-2","label":"Quick Wins","color":"#22C55E","title":"Immediate Fixes","items":["action","action","action","action"]},{"phase":"WEEK 3-6","label":"Core Rebuild","color":"#7B5CF6","title":"Psychological Architecture","items":["action","action","action","action"]},{"phase":"MONTH 2-3","label":"Scale","color":"#E879F9","title":"Growth","items":["action","action","action"]}],"revenueProjection":{"currentConversionRate":"1.4%","projectedConversionRate":"3.1%","estimatedUplift":"+121%","timeframe":"90 days"}}

Be specific to ${domain}. Name real pages/elements. Name psychological principles. Return PURE JSON only.`;
}

const MODELS = ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307'];

// ── Main handler ──────────────────────────────────────────────────────────────
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
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Use POST.' });

  // ── Rate limiting ───────────────────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    console.warn(`[CM] Rate limited: ${ip}`);
    return res.status(429).json({ error: true, message: 'Too many requests. Please wait and try again.' });
  }

  pruneIfNeeded();
  // ── Parse & validate ────────────────────────────────────────────────────────
  let body;
  try { body = await readBody(req); }
  catch (e) { return res.status(400).json({ error: true, message: e.message }); }

  const urlResult = validateUrl(body.url);
  if (!urlResult.ok) return res.status(400).json({ error: true, message: urlResult.error });

  const safeUrl = urlResult.url;
  const safeIndustry = sanitise(body.industry, 60) || 'General Business';
  console.log(`[CM] Analysing: ${safeUrl} | ${safeIndustry} | IP: ${ip}`);

  // ── Cache lookup ────────────────────────────────────────────────────────────
  const cacheKey = `${safeUrl}::${safeIndustry}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
    console.log(`[CM] Cache hit for ${safeUrl}`);
    return res.status(200).json(cached.result);
  }

  // ── API key ─────────────────────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log('[CM] API key present:', apiKey ? `YES (${apiKey.length} chars)` : 'NO');
  if (!apiKey) return res.status(500).json({ error: true, message: 'Server not configured. Contact support.', details: 'ANTHROPIC_API_KEY missing from Vercel env vars.' });

  // ── Call Anthropic with model fallback ──────────────────────────────────────
  const prompt = buildPrompt(safeUrl, safeIndustry);
  let apiResponse = null;
  let lastErr = null;

  for (const model of MODELS) {
    console.log(`[CM] Trying: ${model}`);
    try {
      apiResponse = await callAnthropic(apiKey, model, prompt);
      console.log(`[CM] Success: ${model}`);
      break;
    } catch (e) {
      lastErr = e;
      console.error(`[CM] ${model} failed: ${e.status} ${e.message}`);
      if (e.status === 401) return res.status(500).json({ error: true, message: 'API key invalid. Check ANTHROPIC_API_KEY in Vercel settings.' });
      if (e.status === 429) return res.status(429).json({ error: true, message: 'AI rate limit reached. Please wait a minute and try again.' });
      if (e.status !== 404 && e.status !== 408) break; // unknown error — stop retrying
    }
  }

  if (!apiResponse) {
    return res.status(500).json({
      error: true, message: 'AI analysis failed.',
      details: lastErr ? `${lastErr.status}: ${lastErr.message}` : 'All models failed',
    });
  }

  // ── Extract & parse JSON ────────────────────────────────────────────────────
  const rawText = (apiResponse.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!rawText) return res.status(500).json({ error: true, message: 'AI returned empty response. Please try again.' });

  const first = rawText.indexOf('{');
  const last  = rawText.lastIndexOf('}');
  if (first === -1 || last < first) {
    console.error('[CM] No JSON in response:', rawText.slice(0, 200));
    return res.status(500).json({ error: true, message: 'AI returned unexpected format.', raw: rawText.slice(0, 200) });
  }

  let analysis;
  try { analysis = JSON.parse(rawText.slice(first, last + 1)); }
  catch (e) {
    console.error('[CM] JSON parse failed:', e.message);
    return res.status(500).json({ error: true, message: 'Failed to parse AI response.', raw: rawText.slice(first, first + 200) });
  }

  // ── Validate fields ─────────────────────────────────────────────────────────
  const required = ['siteName','overallScore','overallGrade','overallSummary','scores','weaknesses','psychologicalAnalysis','improvementPlan','revenueProjection'];
  for (const f of required) {
    if (!(f in analysis)) return res.status(500).json({ error: true, message: `Incomplete analysis (missing: ${f}). Please try again.` });
  }

  // ── Cache & return ──────────────────────────────────────────────────────────
  cache.set(cacheKey, { result: analysis, ts: Date.now() });
  console.log(`[CM] Done. Cached result for ${safeUrl}`);
  return res.status(200).json(analysis);
};
