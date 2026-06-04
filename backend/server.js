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
  res.json({ status: 'ok', service: 'Talent GEO Audit API v2' });
});

// ─── DATA FETCHING UTILITIES ──────────────────────────────────────────────────

async function fetchHTML(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TalentGEO-Audit/1.0; +https://cassillon.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    });
    if (!res.ok) return { success: false, status: res.status, html: null };
    const html = await res.text();
    return { success: true, status: res.status, html };
  } catch (e) {
    return { success: false, error: e.message, html: null };
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TalentGEO-Audit/1.0)' },
      timeout: 8000
    });
    if (!res.ok) return { success: false, status: res.status, text: null };
    const text = await res.text();
    return { success: true, status: res.status, text };
  } catch (e) {
    return { success: false, error: e.message, text: null };
  }
}

function extractJSONLD(html) {
  if (!html) return [];
  const blocks = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      blocks.push(parsed);
    } catch (e) {
      blocks.push({ parseError: true, raw: match[1].trim().substring(0, 200) });
    }
  }
  return blocks;
}

function findJobPostingSchema(blocks) {
  for (const block of blocks) {
    if (!block || block.parseError) continue;
    // Handle @graph arrays
    if (block['@graph']) {
      const job = block['@graph'].find(item => item['@type'] === 'JobPosting');
      if (job) return job;
    }
    if (block['@type'] === 'JobPosting') return block;
    // Handle arrays
    if (Array.isArray(block)) {
      const job = block.find(item => item && item['@type'] === 'JobPosting');
      if (job) return job;
    }
  }
  return null;
}

function auditJobPostingSchema(schema) {
  if (!schema) return { present: false, fields: {}, score: 0, gaps: [] };

  const required = ['title', 'description', 'datePosted', 'hiringOrganization', 'jobLocation'];
  const recommended = ['baseSalary', 'employmentType', 'validThrough', 'jobLocationType',
    'applicantLocationRequirements', 'identifier', 'jobBenefits', 'experienceRequirements'];

  const fields = {};
  const gaps = [];

  required.forEach(f => {
    fields[f] = { present: !!schema[f], required: true, value: schema[f] ? String(schema[f]).substring(0, 100) : null };
    if (!schema[f]) gaps.push({ field: f, priority: 'required', impact: 'high' });
  });

  recommended.forEach(f => {
    fields[f] = { present: !!schema[f], required: false, value: schema[f] ? String(schema[f]).substring(0, 100) : null };
    if (!schema[f]) gaps.push({ field: f, priority: 'recommended', impact: 'medium' });
  });

  // Score: required fields worth 10pts each (50 total), recommended 6.25pts each (50 total)
  const requiredScore = required.filter(f => schema[f]).length * 10;
  const recommendedScore = recommended.filter(f => schema[f]).length * 6.25;
  const score = Math.round(requiredScore + recommendedScore);

  return { present: true, fields, score, gaps, schemaType: schema['@type'] };
}

function auditRobotsTxt(text, domain) {
  if (!text) return { found: false, issues: ['robots.txt not found or unreachable'] };

  const issues = [];
  const lines = text.toLowerCase().split('\n');

  // Check for broad Disallow rules that might block job pages
  let currentAgent = null;
  let blocksAll = false;
  let blocksJobs = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('user-agent:')) {
      currentAgent = trimmed.replace('user-agent:', '').trim();
    }
    if (trimmed.startsWith('disallow:')) {
      const path = trimmed.replace('disallow:', '').trim();
      if (currentAgent === '*' || currentAgent === 'googlebot') {
        if (path === '/' || path === '/*') blocksAll = true;
        if (path.includes('/jobs') || path.includes('/careers') || path.includes('/apply')) blocksJobs = true;
      }
    }
  }

  if (blocksAll) issues.push('robots.txt Disallow: / blocks all crawlers from the entire site');
  if (blocksJobs) issues.push('robots.txt blocks /jobs or /careers paths from crawlers');
  if (!text.toLowerCase().includes('sitemap')) issues.push('No Sitemap directive found in robots.txt');

  return {
    found: true,
    hasSitemapDirective: text.toLowerCase().includes('sitemap'),
    blocksAll,
    blocksJobs,
    issues,
    snippet: text.substring(0, 500)
  };
}

function auditSitemap(text) {
  if (!text) return { found: false, issues: ['sitemap.xml not found or unreachable'] };

  const issues = [];
  const urlCount = (text.match(/<url>/gi) || []).length;
  const hasJobUrls = text.includes('/jobs') || text.includes('/careers') || text.includes('/job/') || text.includes('/position');
  const hasLastmod = text.includes('<lastmod>');
  const hasPriority = text.includes('<priority>');

  if (!hasJobUrls) issues.push('Sitemap does not appear to include job posting URLs');
  if (!hasLastmod) issues.push('No <lastmod> dates in sitemap — search engines cannot determine content freshness');
  if (urlCount === 0) issues.push('Sitemap appears empty or malformed');

  return {
    found: true,
    urlCount,
    hasJobUrls,
    hasLastmod,
    hasPriority,
    issues
  };
}

function extractVisibleText(html) {
  if (!html) return '';
  // Strip scripts, styles, and tags
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.substring(0, 3000); // First 3000 chars is enough for content analysis
}

// ─── NORMALIZE DOMAIN ─────────────────────────────────────────────────────────

function normalizeDomain(domain) {
  let d = domain.trim();
  if (!d.startsWith('http')) d = 'https://' + d;
  try {
    const url = new URL(d);
    return url.origin; // e.g. https://careers.acme.com
  } catch (e) {
    return 'https://' + domain.trim();
  }
}

// ─── MAIN AUDIT ENDPOINT ──────────────────────────────────────────────────────

app.post('/audit', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { domain, brand, industry, context, jobUrls } = req.body;

  if (!domain || !brand) {
    return res.status(400).json({ error: 'domain and brand are required' });
  }

  const baseUrl = normalizeDomain(domain);
  const urls = (jobUrls || []).filter(u => u && u.trim().length > 0);

  // ── PARALLEL DATA COLLECTION ─────────────────────────────────────────────

  const [robotsResult, sitemapResult, ...jobPageResults] = await Promise.all([
    fetchText(`${baseUrl}/robots.txt`),
    fetchText(`${baseUrl}/sitemap.xml`),
    ...urls.map(u => fetchHTML(u.trim()))
  ]);

  // ── PARSE COLLECTED DATA ──────────────────────────────────────────────────

  const robotsAudit = auditRobotsTxt(robotsResult.text, baseUrl);
  const sitemapAudit = auditSitemap(sitemapResult.text);

  const jobAudits = jobPageResults.map((result, i) => {
    if (!result.success) {
      return {
        url: urls[i],
        fetchSuccess: false,
        error: result.error || `HTTP ${result.status}`,
        schema: null,
        schemaAudit: null,
        contentPreview: null
      };
    }
    const jsonldBlocks = extractJSONLD(result.html);
    const jobSchema = findJobPostingSchema(jsonldBlocks);
    const schemaAudit = auditJobPostingSchema(jobSchema);
    const contentPreview = extractVisibleText(result.html);

    return {
      url: urls[i],
      fetchSuccess: true,
      jsonldBlockCount: jsonldBlocks.length,
      hasJobPostingSchema: !!jobSchema,
      schemaAudit,
      contentPreview,
      allSchemaTypes: jsonldBlocks
        .filter(b => !b.parseError)
        .map(b => b['@type'] || (b['@graph'] ? '@graph' : 'unknown'))
    };
  });

  // ── BUILD DATA SUMMARY FOR CLAUDE ────────────────────────────────────────

  const realDataSummary = {
    domain: baseUrl,
    robotsTxt: robotsAudit,
    sitemap: sitemapAudit,
    jobPages: jobAudits,
    urlsProvided: urls.length
  };

  // ── CLAUDE PROMPT WITH REAL DATA ─────────────────────────────────────────

  const systemPrompt = `You are the Cassillon AI GEO Audit Engine. You apply the Cassillon AI GEO Optimization Protocol — a five-dimension framework for auditing employer brand and job posting visibility in AI-mediated candidate search.

You will receive REAL audit data collected from the client's actual career site and job posting URLs. Your job is to interpret this real data, identify genuine gaps, and produce an accurate, specific GEO readiness report.

Do not invent findings. Base every score and finding on the real data provided.

Return ONLY valid JSON, no markdown, no preamble. Structure:
{
  "overallScore": 0-100,
  "scoreGrade": "Poor|Fair|Developing|Good|Strong|Excellent",
  "geoProfile": {
    "metrics": [
      {"label": "AI Citation Rate", "value": "string"},
      {"label": "LLM Visibility", "value": "string"},
      {"label": "Structured Data Coverage", "value": "string"},
      {"label": "Brand Entity Strength", "value": "string"},
      {"label": "Distribution Index", "value": "string"},
      {"label": "Content GEO Score", "value": "string"}
    ],
    "signals": [
      {"platform": "Google for Jobs", "status": "ok|warn|fail|na"},
      {"platform": "LinkedIn Jobs", "status": "ok|warn|fail|na"},
      {"platform": "Glassdoor", "status": "ok|warn|fail|na"},
      {"platform": "Indeed ATS Feed", "status": "ok|warn|fail|na"},
      {"platform": "Schema.org JobPosting", "status": "ok|warn|fail|na"},
      {"platform": "Bing Career Search", "status": "ok|warn|fail|na"}
    ],
    "narrative": "3-4 sentence GEO profile narrative based on the real audit data"
  },
  "dimensions": [
    {
      "id": "D1",
      "name": "Schema Integrity",
      "score": 0-100,
      "colorClass": "blue",
      "findings": ["specific finding based on real schema data", "specific finding 2", "specific finding 3"],
      "dataSource": "real"
    },
    {
      "id": "D2",
      "name": "Career Site Hygiene",
      "score": 0-100,
      "colorClass": "teal",
      "findings": ["specific finding based on real robots.txt/sitemap data", "finding 2", "finding 3"],
      "dataSource": "real"
    },
    {
      "id": "D3",
      "name": "Job Posting Content",
      "score": 0-100,
      "colorClass": "amber",
      "findings": ["finding based on real content analysis", "finding 2", "finding 3"],
      "dataSource": "${urls.length > 0 ? 'real' : 'inferred'}"
    },
    {
      "id": "D4",
      "name": "Employer Brand Signals",
      "score": 0-100,
      "colorClass": "purple",
      "findings": ["finding 1", "finding 2", "finding 3"],
      "dataSource": "inferred"
    },
    {
      "id": "D5",
      "name": "Distribution Coverage",
      "score": 0-100,
      "colorClass": "red",
      "findings": ["finding 1", "finding 2", "finding 3"],
      "dataSource": "inferred"
    }
  ],
  "internalActions": [
    {"title": "action title", "description": "specific actionable step referencing real findings", "effort": "Low|Medium|High", "impact": "High|Medium", "dimension": "D1"}
  ],
  "cassillonActions": [
    {"title": "service title", "description": "what Cassillon would deliver", "effort": "Low|Medium|High", "impact": "High|Medium"}
  ]
}

Scoring guidance for D1 (Schema Integrity) based on real data:
- JobPosting schema present with all 5 required fields + 4+ recommended: 80-100
- Schema present with all required fields, few recommended: 55-75
- Schema present but missing required fields: 25-50
- No JobPosting schema found: 5-20

Scoring guidance for D2 (Career Site Hygiene) based on real data:
- robots.txt clean, sitemap found with job URLs and lastmod: 75-100
- Minor issues in robots.txt or sitemap: 45-70
- Significant crawl blocking or sitemap missing: 10-40

Provide exactly 5 internalActions and exactly 4 cassillonActions.
Make all findings and actions specific to the real data — not generic.`;

  const userPrompt = `Audit this employer brand for GEO visibility.

Brand: ${brand}
Domain: ${baseUrl}
Industry: ${industry || 'Not specified'}
Additional context: ${context || 'None'}

REAL AUDIT DATA COLLECTED:

${JSON.stringify(realDataSummary, null, 2)}

Based on this real data, produce the GEO audit report. For D1 and D2, your findings must reference specific things found (or not found) in the actual data above. For D3, analyze the contentPreview from the job pages if available. For D4 and D5, use your knowledge of the brand combined with the signals you can infer from the technical data.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
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

    // Attach raw audit data for transparency
    res.json({ success: true, report, auditData: realDataSummary });

  } catch (err) {
    console.error('Audit error:', err);
    res.status(500).json({ error: 'Audit failed', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Talent GEO backend v2 running on port ${PORT}`);
});
