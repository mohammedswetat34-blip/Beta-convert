// api/analyze.js  —  Vercel Serverless Function (Pro plan — 30s timeout)
// Zero npm dependencies. Pure Node.js built-ins only.
'use strict';

const https = require('https');

// ── In-memory cache (URL → {result, ts}) ─────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── In-memory rate limiter (ip → {count, resetAt}) ───────────────────────────
const rateLimits = new Map();
const RATE_MAX      = 15;
const RATE_WINDOW   = 3600000; // 1 hour

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_WINDOW; }
  entry.count += 1;
  rateLimits.set(ip, entry);
  return entry.count > RATE_MAX;
}

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
    // 25s timeout — safe for Vercel Pro 30s limit
    req.setTimeout(25000, () => { req.destroy(); reject(Object.assign(new Error('Anthropic timed out (25s)'), { status: 408 })); });
    req.on('error', e => reject(Object.assign(new Error('Network error: ' + e.message), { status: 503 })));
    req.write(bodyStr);
    req.end();
  });
}

// ── Full quality prompt ───────────────────────────────────────────────────────
function buildPrompt(url, industry) {
  const domain = url.replace(/^https?:\/\//, '').split('/')[0];
  return `You are a world-class conversion rate optimisation (CRO) expert and consumer psychologist.

Analyse this website: ${url} (${domain}) for the ${industry} industry.

Apply these frameworks rigorously:
1. Cialdini's 7 Principles of Influence (reciprocity, commitment, social proof, authority, liking, scarcity, unity)
2. Cognitive Load Theory — Miller's Law, information architecture
3. Prospect Theory & Loss Aversion (Kahneman & Tversky)
4. Visual Hierarchy & F/Z-Pattern Reading
5. Fogg Behavior Model (motivation × ability × prompt)
6. Pricing psychology & Paradox of Choice
7. CRO best practices — above-fold CTAs, trust signals, clarity, urgency

Return ONLY a valid JSON object starting with { and ending with }. No markdown. No extra text.

{"siteName":"brand name","overallScore":54,"overallGrade":"C+","overallSummary":"2-3 sentence honest assessment of conversion performance","scores":{"trustCredibility":50,"visualHierarchy":60,"conversionFunnel":42,"psychologicalTriggers":47,"messagingClarity":58,"mobileExperience":65},"weaknesses":[{"severity":"HIGH","title":"weakness title","description":"Name the psychological principle and explain the specific problem on this site"},{"severity":"HIGH","title":"title","description":"explanation"},{"severity":"MED","title":"title","description":"explanation"},{"severity":"MED","title":"title","description":"explanation"},{"severity":"LOW","title":"title","description":"explanation"}],"psychologicalAnalysis":[{"trigger":"Social Proof","issue":"specific finding for ${domain}"},{"trigger":"Scarcity / Urgency","issue":"specific finding"},{"trigger":"Authority Signals","issue":"specific finding"},{"trigger":"Loss Aversion","issue":"specific finding"},{"trigger":"Cognitive Load","issue":"specific finding"},{"trigger":"Reciprocity","issue":"specific finding"}],"improvementPlan":[{"phase":"WEEK 1-2","label":"Quick Wins","color":"#22C55E","title":"Immediate High-Impact Fixes","items":["concrete action 1","concrete action 2","concrete action 3","concrete action 4"]},{"phase":"WEEK 3-6","label":"Core Rebuild","color":"#7B5CF6","title":"Psychological Architecture","items":["concrete action 1","concrete action 2","concrete action 3","concrete action 4"]},{"phase":"MONTH 2-3","label":"Scale & Test","color":"#E879F9","title":"Revenue Optimisation & Growth","items":["concrete action 1","concrete action 2","concrete action 3"]}],"revenueProjection":{"currentConversionRate":"1.4%","projectedConversionRate":"3.8%","estimatedUplift":"+171%","timeframe":"90 days"}}

Critical: be specific to ${domain} — reference real pages, real UI elements, real copy you know about this site. Name psychological principles in every weakness description. Return PURE JSON only.`;
}

// ── Model order: sonnet first (best quality), haiku as fallback ───────────────
const MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

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

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    console.warn(`[CM] Rate limited: ${ip}`);
    return res.status(429).json({ error: true, message: 'Too many requests. Please wait and try again.' });
  }

  pruneIfNeeded();

  // ── Parse & validate ───────────────────────────────────────────────────────
  let body;
  try { body = await readBody(req); }
  catch (e) { return res.status(400).json({ error: true, message: e.message }); }

  const urlResult = validateUrl(body.url);
  if (!urlResult.ok) return res.status(400).json({ error: true, message: urlResult.error });

  const safeUrl      = urlResult.url;
  const safeIndustry = sanitise(body.industry, 60) || 'General Business';
  console.log(`[CM] Analysing: ${safeUrl} | ${safeIndustry} | IP: ${ip}`);

  // ── Cache lookup ───────────────────────────────────────────────────────────
  const cacheKey = `${safeUrl}::${safeIndustry}`;
  const cached   = cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
    console.log(`[CM] Cache hit for ${safeUrl}`);
    return res.status(200).json(cached.result);
  }

  // ── API key ────────────────────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log('[CM] API key present:', apiKey ? `YES (${apiKey.length} chars)` : 'NO');
  if (!apiKey) return res.status(500).json({ error: true, message: 'Server not configured. Contact support.', details: 'ANTHROPIC_API_KEY missing.' });

  // ── Call Anthropic with model fallback ─────────────────────────────────────
  const prompt = buildPrompt(safeUrl, safeIndustry);
  let apiResponse = null;
  let lastErr     = null;

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
      if (e.status !== 404 && e.status !== 408) break;
    }
  }

  if (!apiResponse) {
    return res.status(500).json({
      error: true, message: 'AI analysis failed.',
      details: lastErr ? `${lastErr.status}: ${lastErr.message}` : 'All models failed',
    });
  }

  // ── Extract & parse JSON ───────────────────────────────────────────────────
  const rawText = (apiResponse.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!rawText) return res.status(500).json({ error: true, message: 'AI returned empty response. Please try again.' });

  const first = rawText.indexOf('{');
  const last  = rawText.lastIndexOf('}');
  if (first === -1 || last < first) {
    console.error('[CM] No JSON in response:', rawText.slice(0, 200));
    return res.status(500).json({ error: true, message: 'AI returned unexpected format. Please try again.' });
  }

  let analysis;
  try { analysis = JSON.parse(rawText.slice(first, last + 1)); }
  catch (e) {
    console.error('[CM] JSON parse failed:', e.message);
    return res.status(500).json({ error: true, message: 'Failed to parse AI response. Please try again.' });
  }

  // ── Validate fields ────────────────────────────────────────────────────────
  const required = ['siteName','overallScore','overallGrade','overallSummary','scores','weaknesses','psychologicalAnalysis','improvementPlan','revenueProjection'];
  for (const f of required) {
    if (!(f in analysis)) return res.status(500).json({ error: true, message: `Incomplete analysis (missing: ${f}). Please try again.` });
  }

  // ── Cache & return ─────────────────────────────────────────────────────────
  cache.set(cacheKey, { result: analysis, ts: Date.now() });
  console.log(`[CM] Done. Cached result for ${safeUrl}`);
  return res.status(200).json(analysis);
};
