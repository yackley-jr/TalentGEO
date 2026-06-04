const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// The backend's own public URL — used to build the redirect URI
const BACKEND_URL = process.env.BACKEND_URL || 'https://talentgeo-backend-360027703478.us-central1.run.app';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://talentgeo-frontend-360027703478.us-central1.run.app';

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Talent GEO Audit API v4' });
});

// ─── OAUTH: STEP 1 — REDIRECT USER TO GOOGLE ─────────────────────────────────

app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BACKEND_URL}/auth/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    access_type: 'online',
    prompt: 'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ─── OAUTH: STEP 2 — HANDLE GOOGLE CALLBACK ──────────────────────────────────

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?gsc=error&reason=${error || 'no_code'}`);
  }

  try {
    // Exchange auth code for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${BACKEND_URL}/auth/callback`,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error('Token exchange failed:', tokenData);
      return res.redirect(`${FRONTEND_URL}?gsc=error&reason=token_exchange_failed`);
    }

    // Pass the token back to the frontend via URL param
    // Token is short-lived (1hr) and used only for the audit — not stored
    res.redirect(`${FRONTEND_URL}?gsc=connected&token=${encodeURIComponent(tokenData.access_token)}`);

  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${FRONTEND_URL}?gsc=error&reason=server_error`);
  }
});

// ─── GSC DATA FETCHERS ────────────────────────────────────────────────────────

async function fetchGSCSites(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return { success: false, status: res.status };
    const data = await res.json();
    return { success: true, sites: data.siteEntry || [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function fetchGSCSearchAnalytics(accessToken, siteUrl, domain) {
  try {
    // Last 90 days
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          startDate,
          endDate,
          dimensions: ['page'],
          dimensionFilterGroups: [{
            filters: [{
              dimension: 'page',
              operator: 'containsWord',
              expression: 'job'
            }]
          }],
          rowLimit: 25
        })
      }
    );
    if (!res.ok) return { success: false, status: res.status };
    const data = await res.json();
    return { success: true, rows: data.rows || [], totals: data.responseAggregationType };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function fetchGSCIndexCoverage(accessToken, siteUrl) {
  try {
    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/urlInspection/index:inspect`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inspectionUrl: siteUrl,
          siteUrl
        })
      }
    );
    if (!res.ok) return { success: false, status: res.status };
    const data = await res.json();
    return { success: true, result: data.inspectionResult };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function matchSiteToDomain(sites, domain) {
  // Try to find the GSC property that matches the audited domain
  const domainClean = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return sites.find(s => {
    const siteClean = s.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^sc-domain:/, '');
    return siteClean.includes(domainClean) || domainClean.includes(siteClean);
  });
}

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
    if (block['@graph']) {
      const job = block['@graph'].find(item => item['@type'] === 'JobPosting');
      if (job) return job;
    }
    if (block['@type'] === 'JobPosting') return block;
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

  const requiredScore = required.filter(f => schema[f]).length * 10;
  const recommendedScore = recommended.filter(f => schema[f]).length * 6.25;
  const score = Math.round(requiredScore + recommendedScore);

  return { present: true, fields, score, gaps, schemaType: schema['@type'] };
}

function auditRobotsTxt(text, domain) {
  if (!text) return { found: false, issues: ['robots.txt not found or unreachable'] };

  const issues = [];
  const lines = text.toLowerCase().split('\n');
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

  if (!hasJobUrls) issues.push('Sitemap does not appear to include job posting URLs');
  if (!hasLastmod) issues.push('No <lastmod> dates in sitemap — search engines cannot determine content freshness');
  if (urlCount === 0) issues.push('Sitemap appears empty or malformed');

  return { found: true, urlCount, hasJobUrls, hasLastmod, issues };
}

function extractVisibleText(html) {
  if (!html) return '';
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.substring(0, 3000);
}

// ─── D3 SCORING CONFIG ────────────────────────────────────────────────────────
// Edit weights here (must sum to 100) or use the /d3-config admin page.
// Thresholds define what counts as too short, ideal, or too long.

const D3_CONFIG = {
  "weights": {
    "compensation":    30,
    "locationClarity": 15,
    "employmentType":  10,
    "wordCount":       10,
    "answerFirst":     10,
    "reqVsResp":       10,
    "benefitsSignals":  8,
    "readability":      7
  },
  "thresholds": {
    "wordCountMin":   150,
    "wordCountIdeal": 400,
    "wordCountMax":   900
  }
};

// ─── D3 SCORING FUNCTION ──────────────────────────────────────────────────────

function scoreJobPostingContent(text) {
  if (!text || text.trim().length === 0) {
    return {
      score: 0,
      signals: {},
      wordCount: 0,
      note: 'No content available to score'
    };
  }

  const lower = text.toLowerCase();
  const w = D3_CONFIG.weights;
  const t = D3_CONFIG.thresholds;
  const signals = {};

  // ── COMPENSATION TRANSPARENCY (both $ patterns and keywords) ──────────────
  const hasDollarAmount = /\$[\d,]+(\s*(k|\/hr|\/hour|\/year|,000))?/i.test(text);
  const hasCompKeyword  = /\b(salary|compensation|pay range|base pay|hourly rate|ote|on-target earnings|total compensation|annual pay|wage)\b/i.test(lower);
  signals.compensation = hasDollarAmount || hasCompKeyword;

  // ── LOCATION CLARITY ──────────────────────────────────────────────────────
  const hasRemote   = /\b(remote|work from home|wfh|fully remote|remote-first)\b/i.test(lower);
  const hasHybrid   = /\b(hybrid|flexible location|partially remote)\b/i.test(lower);
  const hasOnsite   = /\b(on-?site|in-?office|in person|on location)\b/i.test(lower);
  const hasCity     = /\b([A-Z][a-z]+,?\s+(CA|NY|TX|FL|WA|IL|GA|MA|CO|OR|OH|NC|VA|AZ|MN|NJ|DC|PA|MI|MD|UT|TN|MO|IN|WI)\b)/.test(text);
  signals.locationClarity = hasRemote || hasHybrid || hasOnsite || hasCity;

  // ── EMPLOYMENT TYPE ───────────────────────────────────────────────────────
  signals.employmentType = /\b(full.?time|part.?time|contract|contractor|temporary|temp|freelance|permanent|ftc|w-?2|1099)\b/i.test(lower);

  // ── WORD COUNT ────────────────────────────────────────────────────────────
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  let wordCountScore = 0;
  if (wordCount >= t.wordCountMin && wordCount <= t.wordCountMax) {
    wordCountScore = wordCount >= t.wordCountIdeal
      ? 1
      : (wordCount - t.wordCountMin) / (t.wordCountIdeal - t.wordCountMin);
  } else if (wordCount > t.wordCountMax) {
    // Penalize but don't zero out — too long is better than too short
    wordCountScore = 0.5;
  }
  signals.wordCount = wordCountScore;

  // ── ANSWER-FIRST STRUCTURE ────────────────────────────────────────────────
  // Role summary or "about the role" should appear in first 30% of content
  const firstThird = lower.substring(0, Math.floor(lower.length * 0.3));
  signals.answerFirst = /\b(about (the |this )?(role|position|job|opportunity)|overview|summary|what you('ll| will) do|the role|position summary|job summary)\b/i.test(firstThird);

  // ── REQUIREMENTS VS RESPONSIBILITIES ─────────────────────────────────────
  const hasResp = /\b(responsibilities|what you('ll| will) do|your role|key duties|day.to.day|you will)\b/i.test(lower);
  const hasReqs = /\b(requirements|qualifications|what we('re| are) looking for|must have|you (have|bring)|skills (needed|required)|minimum qualifications)\b/i.test(lower);
  signals.reqVsResp = hasResp && hasReqs;

  // ── BENEFITS SIGNALS ──────────────────────────────────────────────────────
  signals.benefitsSignals = /\b(benefits|401k|pto|vacation|health insurance|dental|vision|equity|stock|rsu|bonus|parental leave|paid leave|unlimited pto|flexible hours|professional development|tuition|wellness)\b/i.test(lower);

  // ── READABILITY ───────────────────────────────────────────────────────────
  // Penalize wall-of-text (no bullets/line breaks) and extreme jargon density
  const hasBulletStructure = (text.match(/\n/g) || []).length > 5;
  const jargonCount = (lower.match(/\b(synergy|leverage|rockstar|ninja|guru|wizard|unicorn|thought leader|disruptive|paradigm|ecosystem|scalable solution)\b/gi) || []).length;
  signals.readability = hasBulletStructure && jargonCount < 3;

  // ── CALCULATE SCORE ───────────────────────────────────────────────────────
  const score = Math.round(
    (signals.compensation    ? w.compensation    : 0) +
    (signals.locationClarity ? w.locationClarity : 0) +
    (signals.employmentType  ? w.employmentType  : 0) +
    (wordCountScore * w.wordCount) +
    (signals.answerFirst     ? w.answerFirst     : 0) +
    (signals.reqVsResp       ? w.reqVsResp       : 0) +
    (signals.benefitsSignals ? w.benefitsSignals : 0) +
    (signals.readability     ? w.readability     : 0)
  );

  return {
    score,
    signals: {
      compensation:    { pass: signals.compensation,    weight: w.compensation,    label: 'Compensation transparency' },
      locationClarity: { pass: signals.locationClarity, weight: w.locationClarity, label: 'Location clarity' },
      employmentType:  { pass: signals.employmentType,  weight: w.employmentType,  label: 'Employment type' },
      wordCount:       { pass: wordCountScore >= 0.75,  weight: w.wordCount,       label: 'Word count quality', wordCount },
      answerFirst:     { pass: signals.answerFirst,     weight: w.answerFirst,     label: 'Answer-first structure' },
      reqVsResp:       { pass: signals.reqVsResp,       weight: w.reqVsResp,       label: 'Requirements vs. responsibilities' },
      benefitsSignals: { pass: signals.benefitsSignals, weight: w.benefitsSignals, label: 'Benefits signals' },
      readability:     { pass: signals.readability,     weight: w.readability,     label: 'Readability' },
    },
    wordCount
  };
}

function normalizeDomain(domain) {
  let d = domain.trim();
  if (!d.startsWith('http')) d = 'https://' + d;
  try {
    const url = new URL(d);
    return url.origin;
  } catch (e) {
    return 'https://' + domain.trim();
  }
}

// ─── MAIN AUDIT ENDPOINT ──────────────────────────────────────────────────────

app.post('/audit', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { domain, brand, industry, context, jobUrls, gscToken } = req.body;

  if (!domain || !brand) {
    return res.status(400).json({ error: 'domain and brand are required' });
  }

  const baseUrl = normalizeDomain(domain);
  const urls = (jobUrls || []).filter(u => u && u.trim().length > 0);

  // ── PARALLEL DATA COLLECTION ──────────────────────────────────────────────

  const [robotsResult, sitemapResult, ...jobPageResults] = await Promise.all([
    fetchText(`${baseUrl}/robots.txt`),
    fetchText(`${baseUrl}/sitemap.xml`),
    ...urls.map(u => fetchHTML(u.trim()))
  ]);

  // ── GSC DATA COLLECTION (if token provided) ───────────────────────────────

  let gscData = { connected: false };

  if (gscToken) {
    try {
      const sitesResult = await fetchGSCSites(gscToken);

      if (sitesResult.success && sitesResult.sites.length > 0) {
        const matchedSite = matchSiteToDomain(sitesResult.sites, baseUrl);

        if (matchedSite) {
          const [analyticsResult, coverageResult] = await Promise.all([
            fetchGSCSearchAnalytics(gscToken, matchedSite.siteUrl, baseUrl),
            fetchGSCIndexCoverage(gscToken, matchedSite.siteUrl)
          ]);

          gscData = {
            connected: true,
            siteUrl: matchedSite.siteUrl,
            permissionLevel: matchedSite.permissionLevel,
            jobPageSearchAnalytics: analyticsResult.success ? {
              rowCount: analyticsResult.rows.length,
              topPages: analyticsResult.rows.slice(0, 10).map(r => ({
                page: r.keys[0],
                clicks: r.clicks,
                impressions: r.impressions,
                ctr: (r.ctr * 100).toFixed(2) + '%',
                position: r.position.toFixed(1)
              })),
              totalClicks: analyticsResult.rows.reduce((sum, r) => sum + r.clicks, 0),
              totalImpressions: analyticsResult.rows.reduce((sum, r) => sum + r.impressions, 0)
            } : { error: 'Analytics unavailable', status: analyticsResult.status },
            indexCoverage: coverageResult.success ? coverageResult.result : { error: 'Coverage data unavailable' }
          };
        } else {
          gscData = {
            connected: true,
            matchedSite: false,
            availableSites: sitesResult.sites.map(s => s.siteUrl),
            note: `GSC account has ${sitesResult.sites.length} properties but none matched ${baseUrl}`
          };
        }
      } else {
        gscData = {
          connected: true,
          matchedSite: false,
          note: sitesResult.success ? 'No GSC properties found in this account' : `GSC API error: ${sitesResult.status}`
        };
      }
    } catch (e) {
      gscData = { connected: true, error: e.message };
    }
  }

  // ── PARSE COLLECTED DATA ──────────────────────────────────────────────────

  const robotsAudit = auditRobotsTxt(robotsResult.text, baseUrl);
  const sitemapAudit = auditSitemap(sitemapResult.text);

  const jobAudits = jobPageResults.map((result, i) => {
    if (!result.success) {
      return { url: urls[i], fetchSuccess: false, error: result.error || `HTTP ${result.status}`, schema: null, schemaAudit: null, contentPreview: null };
    }
    const jsonldBlocks = extractJSONLD(result.html);
    const jobSchema = findJobPostingSchema(jsonldBlocks);
    const schemaAudit = auditJobPostingSchema(jobSchema);
    const contentPreview = extractVisibleText(result.html);
    const d3Score = scoreJobPostingContent(contentPreview);
    return {
      url: urls[i],
      fetchSuccess: true,
      jsonldBlockCount: jsonldBlocks.length,
      hasJobPostingSchema: !!jobSchema,
      schemaAudit,
      contentPreview,
      d3Score,
      allSchemaTypes: jsonldBlocks.filter(b => !b.parseError).map(b => b['@type'] || (b['@graph'] ? '@graph' : 'unknown'))
    };
  });

  const realDataSummary = {
    domain: baseUrl,
    robotsTxt: robotsAudit,
    sitemap: sitemapAudit,
    jobPages: jobAudits,
    urlsProvided: urls.length,
    gsc: gscData
  };

  // ── CLAUDE PROMPT ─────────────────────────────────────────────────────────

  const d3ScoredPages = jobAudits.filter(j => j.fetchSuccess && j.d3Score);
  const d3Context = d3ScoredPages.length > 0
    ? `D3 STRUCTURED CONTENT SCORES AVAILABLE: ${d3ScoredPages.length} job page(s) were scored by the Cassillon D3 engine.
${d3ScoredPages.map(j => {
  const s = j.d3Score;
  const gaps = Object.entries(s.signals).filter(([,v]) => !v.pass).map(([,v]) => v.label);
  const passes = Object.entries(s.signals).filter(([,v]) => v.pass).map(([,v]) => v.label);
  return `- ${j.url}
  Score: ${s.score}/100 | Word count: ${s.wordCount}
  Passing: ${passes.length > 0 ? passes.join(', ') : 'none'}
  Failing: ${gaps.length > 0 ? gaps.join(', ') : 'none'}`;
}).join('\n')}
The D3 dimension score should be the average of these per-URL scores: ${Math.round(d3ScoredPages.reduce((sum, j) => sum + j.d3Score.score, 0) / d3ScoredPages.length)}/100.
Reference specific signal failures in D3 findings. perUrlScores must reflect the actual scores above.`
    : `D3 DATA: No job URLs provided or pages could not be fetched. Score D3 as inferred based on domain/brand knowledge only.`;


    ? `GSC DATA AVAILABLE: Real Google Search Console data has been pulled for ${gscData.siteUrl}.
- Job pages found in GSC: ${(gscData.jobPageSearchAnalytics && gscData.jobPageSearchAnalytics.rowCount) || 0}
- Total impressions (90 days): ${(gscData.jobPageSearchAnalytics && gscData.jobPageSearchAnalytics.totalImpressions) || 0}
- Total clicks (90 days): ${(gscData.jobPageSearchAnalytics && gscData.jobPageSearchAnalytics.totalClicks) || 0}
Use this data to give precise, accurate D1 and D2 scores. Reference specific impression/click numbers in findings.`
    : `GSC DATA: Not connected. Score D1 and D2 based on schema and robots.txt/sitemap data only. Note in findings that connecting GSC would provide deeper insights.`;

  const systemPrompt = `You are the Cassillon AI GEO Audit Engine. You apply the Cassillon AI GEO Optimization Protocol — a five-dimension framework for auditing employer brand and job posting visibility in AI-mediated candidate search.

You will receive REAL audit data collected from the client's actual career site, job posting URLs, and optionally Google Search Console.

Do not invent findings. Base every score and finding on the real data provided.

${gscContext}

${d3Context}

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
      "findings": ["specific finding referencing real schema and GSC data", "finding 2", "finding 3"],
      "dataSource": "${gscData.connected && gscData.siteUrl ? 'gsc+real' : 'real'}"
    },
    {
      "id": "D2",
      "name": "Career Site Hygiene",
      "score": 0-100,
      "colorClass": "teal",
      "findings": ["specific finding referencing real robots.txt/sitemap and GSC coverage data", "finding 2", "finding 3"],
      "dataSource": "${gscData.connected && gscData.siteUrl ? 'gsc+real' : 'real'}"
    },
    {
      "id": "D3",
      "name": "Job Posting Content",
      "score": 0-100,
      "colorClass": "amber",
      "findings": ["specific finding referencing the per-URL D3 scores and signal breakdowns", "finding 2", "finding 3"],
      "dataSource": "${urls.length > 0 ? 'real' : 'inferred'}",
      "perUrlScores": [{"url": "string", "score": 0-100, "topGaps": ["signal that failed"]}]
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

Provide exactly 5 internalActions and exactly 4 cassillonActions.
Make all findings and actions specific to the real data — not generic.`;

  const userPrompt = `Audit this employer brand for GEO visibility.

Brand: ${brand}
Domain: ${baseUrl}
Industry: ${industry || 'Not specified'}
Additional context: ${context || 'None'}

REAL AUDIT DATA:
${JSON.stringify(realDataSummary, null, 2)}`;

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
        max_tokens: 4096,
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
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const report = JSON.parse(clean);

    res.json({ success: true, report, auditData: realDataSummary });

  } catch (err) {
    console.error('Audit error:', err);
    res.status(500).json({ error: 'Audit failed', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Talent GEO backend v4 running on port ${PORT}`);
});
