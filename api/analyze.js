// api/analyze.js — ConvertIQ v2 · Vercel Serverless Function
// POST /api/analyze
// API key is read ONLY from process.env — never exposed to the browser.

const https = require('https');

module.exports = async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', message: 'Use POST.' });
  }

  // ── API key guard ──────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[ConvertIQ] ANTHROPIC_API_KEY not set');
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'ANTHROPIC_API_KEY is not configured in Vercel environment variables.',
    });
  }

  // ── Parse body ─────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON', message: 'Request body must be valid JSON.' }); }
  }

  const { url } = body || {};
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Missing URL', message: 'Please provide a website URL to analyze.' });
  }

  // ── Normalise & validate URL ───────────────────────────────────────
  let parsedUrl;
  try {
    const raw = url.trim();
    parsedUrl = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    return res.status(400).json({
      error: 'Invalid URL',
      message: 'The URL you entered is not valid. Example: https://stripe.com',
    });
  }

  const cleanUrl = parsedUrl.href;
  const domain   = parsedUrl.hostname.replace(/^www\./, '');
  const path     = parsedUrl.pathname;

  // ── Build prompt ───────────────────────────────────────────────────
  const prompt = buildPrompt(cleanUrl, domain, path);

  // ── Call Anthropic ─────────────────────────────────────────────────
  let anthropicResponse;
  try {
    anthropicResponse = await callAnthropic(apiKey, prompt);
  } catch (err) {
    console.error('[ConvertIQ] Anthropic API error:', err.message);
    return res.status(502).json({
      error: 'AI service error',
      message: 'The AI analysis service is temporarily unavailable. Please try again in a moment.',
    });
  }

  const content = anthropicResponse?.content?.[0]?.text;
  if (!content) {
    console.error('[ConvertIQ] Empty Anthropic response');
    return res.status(502).json({ error: 'Empty AI response', message: 'The AI returned an empty response. Please try again.' });
  }

  // ── Parse JSON ─────────────────────────────────────────────────────
  let analysis;
  try {
    const cleaned = content
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '')
      .trim();
    analysis = JSON.parse(cleaned);
  } catch {
    console.error('[ConvertIQ] JSON parse failed. Raw (500):', content.substring(0, 500));
    return res.status(502).json({
      error: 'Invalid AI response format',
      message: 'The AI returned an unexpected format. Please try again.',
    });
  }

  return res.status(200).json({
    success: true,
    url: cleanUrl,
    analysis,
    analyzedAt: new Date().toISOString(),
  });
};

// ─────────────────────────────────────────────────────────────────────
// PROMPT
// ─────────────────────────────────────────────────────────────────────
function buildPrompt(cleanUrl, domain, path) {
  return `You are a world-class senior conversion rate optimization (CRO) consultant. You have 15+ years of hands-on experience personally auditing thousands of websites — from seed-stage startups to Fortune 500 brands. Your audits are known in the industry for being ruthlessly honest, deeply specific, and immediately actionable. Clients pay $5,000–$25,000 for your reports.

You are now auditing: ${cleanUrl}
Domain: ${domain}
Path: ${path}

Your task: Produce a senior-level CRO audit that feels like a consultant personally reviewed this specific site — not generic AI-generated advice. Every observation must reference the specific domain, inferred industry, likely audience, and realistic business model. If you can infer what the site sells, who it sells to, and how it makes money — use that context aggressively.

IMPORTANT RULES:
1. Never write generic advice that could apply to any site ("Add more testimonials", "Improve your CTA"). Always be specific: reference the domain, the likely page type, the probable user journey, and the specific section being discussed.
2. Do not mention that you cannot visit the URL. Reason authoritatively from the domain name, URL structure, TLD, path, and industry knowledge.
3. Scores should be realistic. Most sites score 42–68 overall. Only exceptional sites score above 75. Sites with obvious trust/CRO problems score below 50.
4. The psychology notes must be real psychological principles (cognitive load, social proof, loss aversion, anchoring, etc.) — not marketing buzzwords.
5. Business impact estimates should be specific and credible (e.g., "likely contributing to a 35–50% bounce rate in mobile sessions" — not "may hurt conversions").
6. The executive summary must read like the opening paragraph of a $10,000 consulting report — no fluff, specific observations, honest assessment.

Return ONLY a raw JSON object — no markdown, no code fences, no commentary before or after:

{
  "overallScore": <integer 0–100>,
  "grade": "<A+|A|A-|B+|B|B-|C+|C|C-|D|F>",
  "industry": "<detected vertical, e.g. 'B2B SaaS', 'E-commerce', 'Marketing Agency', 'Healthcare', 'FinTech', 'Creator Tools', 'Marketplace'>",
  "pageType": "<e.g. 'Homepage', 'SaaS Landing Page', 'Product Page', 'Lead Gen Page', 'Portfolio'>",
  "urgencyLevel": "<Critical|High|Moderate|Low>",

  "executiveSummary": "<4–5 sentences. This must read like the opening of a senior consulting report. Reference the domain by name, describe what the business appears to do, name 2–3 specific conversion problems visible from structure/copy/trust analysis, and give an honest headline verdict. No generic AI language. No 'overall the site does a decent job'. Be direct and specific.>",

  "highestImpactFix": "<The single most important change — must be site-specific, not generic. Something a CRO expert would flag in the first 5 minutes. Reference a specific section or element.>",

  "scores": {
    "firstImpression":  <integer 0–100>,
    "valueProposition": <integer 0–100>,
    "callToAction":     <integer 0–100>,
    "trustSignals":     <integer 0–100>,
    "mobileExperience": <integer 0–100>,
    "pageSpeed":        <integer 0–100>,
    "copyClarity":      <integer 0–100>,
    "visualHierarchy":  <integer 0–100>
  },

  "scoreLabels": {
    "firstImpression":  "<1 sentence explaining this specific score — what does or doesn't work about first impression on this specific site>",
    "valueProposition": "<1 sentence — site-specific>",
    "callToAction":     "<1 sentence — site-specific>",
    "trustSignals":     "<1 sentence — site-specific>",
    "mobileExperience": "<1 sentence — site-specific>",
    "pageSpeed":        "<1 sentence — site-specific>",
    "copyClarity":      "<1 sentence — site-specific>",
    "visualHierarchy":  "<1 sentence — site-specific>"
  },

  "criticalIssues": [
    {
      "title": "<Short, specific issue title — must reference the actual site, not generic>",
      "section": "<Exact section — e.g. 'Hero headline', 'Pricing section', 'Navigation bar', 'Above-the-fold CTA', 'Footer', 'Product description', 'Checkout flow'>",
      "description": "<2–3 sentences. What is specifically wrong. Reference the likely industry, audience, and page element. Imagine you spent 20 minutes on this page — what exactly did you see?>",
      "psychologyNote": "<1–2 sentences. Which psychological principle is being violated or missed — e.g. 'Cognitive load theory: visitors arriving from a paid ad encounter 4 competing CTAs in the first viewport, creating decision paralysis before they understand the offer.' Be academically precise.>",
      "businessImpact": "<Specific estimated impact — e.g. 'Based on industry benchmarks for ${domain.split('.')[0]}-category sites, this issue likely contributes to a 25–40% drop-off at this stage of the funnel.' Be credible, not vague.>",
      "userFeeling": "<What a real visitor feels at this moment — write from the visitor's POV, conversational, honest. e.g. 'I landed here from a Google ad but I still can't tell what exactly I'd be paying for. Am I signing up for software? A service? I'm about to leave.'>",
      "fix": "<Specific, implementable recommendation. Include copy suggestions, layout changes, or technical fixes where appropriate. Enough detail for a developer or designer to act on immediately.>",
      "effort": "<Quick (hours)|Medium (days)|Investment (weeks)>",
      "impact": "<High|Medium|Low>"
    }
  ],

  "quickWins": [
    {
      "title": "<Quick win title — specific to this site>",
      "description": "<What exactly to change, and why it will work for this specific site and audience>",
      "estimatedLift": "<Specific range — e.g. '+12–22% click-through on primary CTA'>",
      "effort": "<Quick (hours)|Medium (days)>",
      "category": "<Copy|Design|Trust|CTA|UX|Speed>"
    }
  ],

  "strengths": [
    {
      "title": "<Strength title — site-specific>",
      "description": "<What they're doing well and why it helps conversions — be specific to this site>"
    }
  ],

  "conversionLeaks": [
    "<Specific drop-off point — e.g. 'Visitors arriving on mobile likely abandon at the pricing section because the comparison table requires horizontal scrolling on small viewports'>",
    "<Another specific leak — reference a real place in the funnel>",
    "<Optional third leak>"
  ],

  "competitorGap": "<1–2 sentences. What do top competitors in this specific vertical typically do better? Reference the industry and 1–2 specific practices this site is missing relative to the category standard.>",

  "nextSteps": [
    "<Priority action #1 — specific, sequenced, with a reason why it comes first>",
    "<Priority action #2 — builds on #1 or addresses next most critical issue>",
    "<Priority action #3 — medium-term improvement>"
  ]
}

Array sizes:
- criticalIssues: 3–5 items, ordered highest impact first
- quickWins: 3–4 items
- strengths: 2–4 items
- conversionLeaks: 2–3 items
- nextSteps: exactly 3 items

Final check before responding: Read every field. If any observation could apply to a random website without changing a word — rewrite it to be specific to ${domain}.`;
}

// ─────────────────────────────────────────────────────────────────────
// ANTHROPIC CALL
// ─────────────────────────────────────────────────────────────────────
function callAnthropic(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Anthropic ${res.statusCode}: ${parsed?.error?.message || data.substring(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse Anthropic response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(58000, () => { req.destroy(); reject(new Error('Anthropic API timed out')); });
    req.write(body);
    req.end();
  });
}
