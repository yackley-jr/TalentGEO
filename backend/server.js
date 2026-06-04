const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Talent GEO Audit API' });
});

// Main audit endpoint
app.post('/audit', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { domain, brand, industry, context } = req.body;

  if (!domain || !brand) {
    return res.status(400).json({ error: 'domain and brand are required' });
  }

  const systemPrompt = `You are the Cassillon AI GEO Audit Engine. Given a brand/domain, produce a realistic GEO audit JSON report applying the Cassillon AI GEO Optimization Protocol across five dimensions.

Return ONLY valid JSON, no markdown, no preamble. Structure:
{
  "overallScore": 0-100,
  "scoreGrade": "Poor|Fair|Developing|Good|Strong|Excellent",
  "geoProfile": {
    "metrics": [
      {"label": "AI Citation Rate", "value": "string with % or descriptor"},
      {"label": "LLM Visibility", "value": "descriptor"},
      {"label": "Structured Data Coverage", "value": "%"},
      {"label": "Brand Entity Strength", "value": "descriptor"},
      {"label": "Distribution Index", "value": "0-100 number as string"},
      {"label": "Content GEO Score", "value": "0-100 number as string"}
    ],
    "signals": [
      {"platform": "Google for Jobs", "status": "ok|warn|fail|na"},
      {"platform": "LinkedIn Jobs", "status": "ok|warn|fail|na"},
      {"platform": "Glassdoor", "status": "ok|warn|fail|na"},
      {"platform": "Indeed ATS Feed", "status": "ok|warn|fail|na"},
      {"platform": "Schema.org JobPosting", "status": "ok|warn|fail|na"},
      {"platform": "Bing Career Search", "status": "ok|warn|fail|na"}
    ],
    "narrative": "3-4 sentence GEO profile narrative explaining the AI visibility landscape for this brand"
  },
  "dimensions": [
    {"id": "D1", "name": "Schema Integrity", "score": 0-100, "colorClass": "blue", "findings": ["finding 1", "finding 2", "finding 3"]},
    {"id": "D2", "name": "Career Site Hygiene", "score": 0-100, "colorClass": "teal", "findings": ["finding 1", "finding 2", "finding 3"]},
    {"id": "D3", "name": "Job Posting Content", "score": 0-100, "colorClass": "amber", "findings": ["finding 1", "finding 2", "finding 3"]},
    {"id": "D4", "name": "Employer Brand Signals", "score": 0-100, "colorClass": "purple", "findings": ["finding 1", "finding 2", "finding 3"]},
    {"id": "D5", "name": "Distribution Coverage", "score": 0-100, "colorClass": "red", "findings": ["finding 1", "finding 2", "finding 3"]}
  ],
  "internalActions": [
    {"title": "action title", "description": "clear specific action", "effort": "Low|Medium|High", "impact": "High|Medium", "dimension": "D1"}
  ],
  "cassillonActions": [
    {"title": "service title", "description": "what Cassillon would deliver", "effort": "Low|Medium|High", "impact": "High|Medium"}
  ]
}

Rules:
- Well-known companies (Google, Microsoft, Amazon, etc.) score 60-80
- Medium companies score 35-60
- Unknown/small companies score 15-45
- Make scores varied across dimensions — no company is uniform
- Provide exactly 5 internalActions and exactly 4 cassillonActions
- Findings must be specific to the brand and industry, not generic`;

  const userPrompt = `Audit this employer brand for GEO visibility:
Domain: ${domain}
Brand: ${brand}
Industry: ${industry || 'Not specified'}
Additional context: ${context || 'None provided'}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'Upstream API error', detail: err });
    }

    const data = await response.json();
    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const clean = text.replace(/```json|```/g, '').trim();
    const report = JSON.parse(clean);

    res.json({ success: true, report });
  } catch (err) {
    console.error('Audit error:', err);
    res.status(500).json({ error: 'Audit failed', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Talent GEO backend running on port ${PORT}`);
});
