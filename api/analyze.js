// api/analyze.js — Vercel Serverless Function
// This is the ONLY backend file. It handles POST /api/analyze.
// It calls the Anthropic API server-side so the API key is never exposed to the browser.

const https = require('https');

module.exports = async function handler(req, res) {
  // ── CORS headers (allow your domain + localhost for testing) ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ── Preflight ──
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── Method guard ──
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed',
      message: 'This endpoint only accepts POST requests.',
    });
  }

  // ── API key guard ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[analyze] ANTHROPIC_API_KEY is not set');
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'The AI service is not configured. Please contact support.',
    });
  }

  // ── Parse body ──
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({
        error: 'Invalid JSON',
        message: 'Request body must be valid JSON.',
      });
    }
  }

  const { url } = body || {};

  // ── URL guard ──
  if (!url || typeof url !== 'string' || url.trim() === '') {
    return res.status(400).json({
      error: 'Missing URL',
      message: 'Please provide a website URL to analyze.',
    });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url.trim().startsWith('http') ? url.trim() : 'https://' + url.trim());
  } catch {
    return res.status(400).json({
      error: 'Invalid URL',
      message: 'The URL you entered is not valid. Please enter a full website URL like https://example.com',
    });
  }

  const cleanUrl = parsedUrl.href;

  // ── Build Anthropic prompt ──
  const prompt = `You are a world-class conversion rate optimization (CRO) expert and UX analyst. Analyze the following website URL and provide a detailed, actionable audit.

Website URL: ${cleanUrl}

Provide your analysis in the following JSON format ONLY (no markdown, no text before or after — just the raw JSON object):

{
  "overallScore": <number 0-100>,
  "grade": "<A+|A|A-|B+|B|B-|C+|C|C-|D|F>",
  "summary": "<2-3 sentence executive summary of the site's conversion performance>",
  "scores": {
    "firstImpression": <number 0-100>,
    "valueProposition": <number 0-100>,
    "callToAction": <number 0-100>,
    "trustSignals": <number 0-100>,
    "mobileExperience": <number 0-100>,
    "pageSpeed": <number 0-100>,
    "copyClarity": <number 0-100>,
    "visualHierarchy": <number 0-100>
  },
  "criticalIssues": [
    {
      "title": "<issue title>",
      "description": "<specific description of the problem>",
      "impact": "<High|Medium|Low>",
      "fix": "<specific actionable fix>"
    }
  ],
  "quickWins": [
    {
      "title": "<quick win title>",
      "description": "<what to do>",
      "estimatedLift": "<estimated conversion lift e.g. +5-15%>"
    }
  ],
  "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "topRecommendation": "<single most important thing they should do right now>"
}

Base your analysis on:
- The URL structure and domain
- Industry best practices for the apparent type of website
- CRO principles (above-the-fold content, CTA placement, social proof, etc.)
- Mobile-first design considerations
- Trust and credibility signals

Provide 3-5 critical issues and 3-4 quick wins. Be specific, direct, and actionable. Do NOT make up fictional details — base everything on reasonable inference from the URL and industry context.`;

  // ── Call Anthropic API ──
  let anthropicResponse;
  try {
    anthropicResponse = await callAnthropic(apiKey, prompt);
  } catch (err) {
    console.error('[analyze] Anthropic API error:', err.message);
    return res.status(502).json({
      error: 'AI service error',
      message: 'The AI analysis service is temporarily unavailable. Please try again in a moment.',
      detail: err.message,
    });
  }

  // ── Extract content ──
  const content = anthropicResponse?.content?.[0]?.text;
  if (!content) {
    console.error('[analyze] Empty response from Anthropic:', JSON.stringify(anthropicResponse));
    return res.status(502).json({
      error: 'Empty AI response',
      message: 'The AI returned an empty response. Please try again.',
    });
  }

  // ── Parse JSON from AI response ──
  let analysis;
  try {
    // Strip any accidental markdown code fences
    const cleaned = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    analysis = JSON.parse(cleaned);
  } catch {
    console.error('[analyze] Failed to parse AI JSON. Raw content:', content.substring(0, 500));
    return res.status(502).json({
      error: 'Invalid AI response format',
      message: 'The AI returned an unexpected response format. Please try again.',
    });
  }

  // ── Success ──
  return res.status(200).json({
    success: true,
    url: cleanUrl,
    analysis,
    analyzedAt: new Date().toISOString(),
  });
};

// ── Helper: call Anthropic Messages API ──
function callAnthropic(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 2048,
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

    const reqHttp = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Anthropic API error ${res.statusCode}: ${parsed?.error?.message || data}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse Anthropic response: ${data.substring(0, 200)}`));
        }
      });
    });

    reqHttp.on('error', (err) => reject(err));
    reqHttp.setTimeout(25000, () => {
      reqHttp.destroy();
      reject(new Error('Anthropic API request timed out after 25 seconds'));
    });

    reqHttp.write(body);
    reqHttp.end();
  });
}
