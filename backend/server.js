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
  res.json({ status: 'ok', service: 'Talent GEO Audit API v6' });
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
  const domainClean = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return sites.find(s => {
    const siteClean = s.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^sc-domain:/, '');
    return siteClean.includes(domainClean) || domainClean.includes(siteClean);
  });
}

// ─── D4: REDDIT RSS FETCHER ───────────────────────────────────────────────────
// Uses Reddit's public RSS feeds — no credentials, no API approval required.
// Reddit explicitly supports RSS as a no-auth access method.
// We get post titles, subreddit, date, and URL — sufficient for sentiment scoring.

const D4_SUBREDDITS = [
  'cscareerquestions',
  'recruitinghell',
  'jobs',
  'careerguidance',
  'jobsearchhacks',
  'ExperiencedDevs',
  'datascience',
  'engineering'
];

function parseRedditRSS(xml) {
  // Extract <entry> blocks (Atom format Reddit uses)
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];

    // Title — strip CDATA if present
    const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';

    // Link href
    const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
    const url = linkMatch ? linkMatch[1] : '';

    // Subreddit — extract from URL path (/r/subredditname/)
    const subredditMatch = url.match(/reddit\.com\/r\/([^/]+)/i);
    const subreddit = subredditMatch ? subredditMatch[1] : '';

    // Date
    const dateMatch = block.match(/<updated>([\s\S]*?)<\/updated>/i);
    const created = dateMatch ? dateMatch[1].trim().split('T')[0] : null;

    if (title) entries.push({ title, url, subreddit, created });
  }
  return entries;
}

async function fetchRedditSignals(brand) {
  const results = {
    success: false,
    totalMentions: 0,
    posts: [],
    subredditsFound: [],
    sentimentBreakdown: { positive: 0, negative: 0, neutral: 0 },
    topSignals: [],
    error: null
  };

  const RSS_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; TalentGEO/1.0)',
    'Accept': 'application/rss+xml, application/atom+xml, text/xml, */*'
  };

  try {
    // RSS Feed 1: broad Reddit search
    const broadUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(brand)}&sort=relevance&t=year&limit=25`;
    const broadRes = await fetch(broadUrl, { headers: RSS_HEADERS, timeout: 10000 });

    if (!broadRes.ok) {
      results.error = `Reddit RSS returned ${broadRes.status}`;
      return results;
    }

    const broadXml = await broadRes.text();
    const broadEntries = parseRedditRSS(broadXml);

    // RSS Feed 2: brand + employer/company search for candidate context
    let targetedEntries = [];
    try {
      const targetedUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(brand + ' employer')}&sort=relevance&t=year&limit=15`;
      const targetedRes = await fetch(targetedUrl, { headers: RSS_HEADERS, timeout: 8000 });
      if (targetedRes.ok) {
        const targetedXml = await targetedRes.text();
        targetedEntries = parseRedditRSS(targetedXml);
      }
    } catch (e) {
      // Non-fatal — broad results are sufficient
    }

    // Deduplicate by URL
    const seen = new Set();
    const allEntries = [...broadEntries, ...targetedEntries].filter(e => {
      if (!e.url || seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    });

    if (allEntries.length === 0) {
      results.success = true;
      results.totalMentions = 0;
      results.note = 'No Reddit mentions found — brand may be too new, niche, or not discussed publicly.';
      return results;
    }

    // Sentiment keyword detection on title text
    const positiveKeywords = /\b(great|excellent|amazing|love|fantastic|awesome|recommend|best|positive|impressed|helpful|transparent|fair|good culture|good pay|benefits|growth|collaborative|innovative|supportive|exciting|opportunity|strong|solid|reputable|trusted)\b/i;
    const negativeKeywords = /\b(avoid|terrible|awful|worst|toxic|nightmare|scam|run away|layoffs|underpaid|overworked|micromanage|poor management|bad culture|no work.?life|burnout|red flag|ghost|ghosted|recruiter issues|bait and switch|misleading|shady|hostile|chaotic|disorganized|low pay|underpay)\b/i;

    const processedEntries = allEntries.map(e => {
      const text = e.title.toLowerCase();
      const isPositive = positiveKeywords.test(text);
      const isNegative = negativeKeywords.test(text);

      let sentiment = 'neutral';
      if (isPositive && !isNegative) sentiment = 'positive';
      else if (isNegative && !isPositive) sentiment = 'negative';
      else if (isNegative && isPositive) sentiment = 'mixed';

      return { ...e, title: e.title.substring(0, 120), sentiment };
    });

    // Prioritize posts that mention the brand by name or are from candidate subreddits
    const brandLower = brand.toLowerCase();
    const relevantEntries = processedEntries.filter(e =>
      e.title.toLowerCase().includes(brandLower) ||
      D4_SUBREDDITS.includes((e.subreddit || '').toLowerCase())
    );

    const finalEntries = relevantEntries.length >= 3 ? relevantEntries : processedEntries.slice(0, 20);

    // Tally sentiment
    finalEntries.forEach(e => {
      if (e.sentiment === 'positive') results.sentimentBreakdown.positive++;
      else if (e.sentiment === 'negative') results.sentimentBreakdown.negative++;
      else results.sentimentBreakdown.neutral++;
    });

    results.subredditsFound = [...new Set(finalEntries.map(e => e.subreddit).filter(Boolean))];
    results.posts = finalEntries.slice(0, 8); // top 8 for Claude prompt
    results.totalMentions = finalEntries.length;
    results.success = true;

    // Build signal summaries for Claude
    const negPosts = finalEntries.filter(e => e.sentiment === 'negative');
    const posPosts = finalEntries.filter(e => e.sentiment === 'positive');

    if (negPosts.length > 0) results.topSignals.push({ type: 'negative', count: negPosts.length, topPost: negPosts[0].title });
    if (posPosts.length > 0) results.topSignals.push({ type: 'positive', count: posPosts.length, topPost: posPosts[0].title });

    const candidateSubreddits = finalEntries
      .filter(e => D4_SUBREDDITS.includes((e.subreddit || '').toLowerCase()))
      .map(e => e.subreddit);
    if (candidateSubreddits.length > 0) {
      results.topSignals.push({ type: 'candidate_subreddit_presence', subreddits: [...new Set(candidateSubreddits)] });
    }

  } catch (e) {
    results.error = e.message;
    results.success = false;
  }

  return results;
}

// ─── D4: SENTIMENT SCORING ────────────────────────────────────────────────────
// Produces a 0–100 score from Reddit signal data.
// This score is passed to Claude as a suggested D4 score — Claude can adjust
// based on the full context (brand size, industry, post quality, etc.)

function scoreD4Sentiment(redditData) {
  // If Reddit fetch failed entirely, return null so Claude scores D4 as inferred
  if (!redditData || !redditData.success) return null;

  // No mentions found — neutral baseline, not penalized heavily
  // (small companies may simply not be discussed)
  if (redditData.totalMentions === 0) {
    return {
      suggestedScore: 45,
      basis: 'no_mentions',
      note: 'No Reddit mentions found. Brand may be small/niche. Neutral baseline applied.'
    };
  }

  const { positive, negative, neutral } = redditData.sentimentBreakdown;
  const total = positive + negative + neutral;

  // Sentiment ratio score (0–60 points)
  const positiveRatio = positive / total;
  const negativeRatio = negative / total;
  const sentimentScore = Math.round((positiveRatio * 60) - (negativeRatio * 40));
  const clampedSentiment = Math.max(0, Math.min(60, sentimentScore + 30)); // baseline 30

  // Volume score (0–20 points) — more mentions = more brand authority signal
  let volumeScore = 0;
  if (redditData.totalMentions >= 20) volumeScore = 20;
  else if (redditData.totalMentions >= 10) volumeScore = 15;
  else if (redditData.totalMentions >= 5) volumeScore = 10;
  else volumeScore = 5;

  // Candidate subreddit presence (0–20 points)
  const inCandidateSubreddits = redditData.topSignals.some(s => s.type === 'candidate_subreddit_presence');
  const candidatePresenceScore = inCandidateSubreddits ? 20 : 5;

  const total_score = Math.min(100, Math.round(clampedSentiment + volumeScore + candidatePresenceScore));

  return {
    suggestedScore: total_score,
    basis: 'reddit_signals',
    sentimentRatio: { positive: positiveRatio.toFixed(2), negative: negativeRatio.toFixed(2) },
    volumeScore,
    candidatePresenceScore
  };
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
    return { score: 0, signals: {}, wordCount: 0, note: 'No content available to score' };
  }

  const lower = text.toLowerCase();
  const w = D3_CONFIG.weights;
  const t = D3_CONFIG.thresholds;
  const signals = {};

  const hasDollarAmount = /\$[\d,]+(\s*(k|\/hr|\/hour|\/year|,000))?/i.test(text);
  const hasCompKeyword  = /\b(salary|compensation|pay range|base pay|hourly rate|ote|on-target earnings|total compensation|annual pay|wage)\b/i.test(lower);
  signals.compensation = hasDollarAmount || hasCompKeyword;

  const hasRemote   = /\b(remote|work from home|wfh|fully remote|remote-first)\b/i.test(lower);
  const hasHybrid   = /\b(hybrid|flexible location|partially remote)\b/i.test(lower);
  const hasOnsite   = /\b(on-?site|in-?office|in person|on location)\b/i.test(lower);
  const hasCity     = /\b([A-Z][a-z]+,?\s+(CA|NY|TX|FL|WA|IL|GA|MA|CO|OR|OH|NC|VA|AZ|MN|NJ|DC|PA|MI|MD|UT|TN|MO|IN|WI)\b)/.test(text);
  signals.locationClarity = hasRemote || hasHybrid || hasOnsite || hasCity;

  signals.employmentType = /\b(full.?time|part.?time|contract|contractor|temporary|temp|freelance|permanent|ftc|w-?2|1099)\b/i.test(lower);

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  let wordCountScore = 0;
  if (wordCount >= t.wordCountMin && wordCount <= t.wordCountMax) {
    wordCountScore = wordCount >= t.wordCountIdeal
      ? 1
      : (wordCount - t.wordCountMin) / (t.wordCountIdeal - t.wordCountMin);
  } else if (wordCount > t.wordCountMax) {
    wordCountScore = 0.5;
  }
  signals.wordCount = wordCountScore;

  const firstThird = lower.substring(0, Math.floor(lower.length * 0.3));
  signals.answerFirst = /\b(about (the |this )?(role|position|job|opportunity)|overview|summary|what you('ll| will) do|the role|position summary|job summary)\b/i.test(firstThird);

  const hasResp = /\b(responsibilities|what you('ll| will) do|your role|key duties|day.to.day|you will)\b/i.test(lower);
  const hasReqs = /\b(requirements|qualifications|what we('re| are) looking for|must have|you (have|bring)|skills (needed|required)|minimum qualifications)\b/i.test(lower);
  signals.reqVsResp = hasResp && hasReqs;

  signals.benefitsSignals = /\b(benefits|401k|pto|vacation|health insurance|dental|vision|equity|stock|rsu|bonus|parental leave|paid leave|unlimited pto|flexible hours|professional development|tuition|wellness)\b/i.test(lower);

  const hasBulletStructure = (text.match(/\n/g) || []).length > 5;
  const jargonCount = (lower.match(/\b(synergy|leverage|rockstar|ninja|guru|wizard|unicorn|thought leader|disruptive|paradigm|ecosystem|scalable solution)\b/gi) || []).length;
  signals.readability = hasBulletStructure && jargonCount < 3;

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

  const { domain, brand, industry, context, jobUrls, gscToken, selectedATS } = req.body;

  if (!domain || !brand) {
    return res.status(400).json({ error: 'domain and brand are required' });
  }

  const baseUrl = normalizeDomain(domain);
  const urls = (jobUrls || []).filter(u => u && u.trim().length > 0);

  // ── PARALLEL DATA COLLECTION ──────────────────────────────────────────────
  // Reddit runs in parallel with the rest — D4 data arrives at the same time

  const [robotsResult, sitemapResult, redditResult, ...jobPageResults] = await Promise.all([
    fetchText(`${baseUrl}/robots.txt`),
    fetchText(`${baseUrl}/sitemap.xml`),
    fetchRedditSignals(brand),
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
  const d4Score = scoreD4Sentiment(redditResult);

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
    gsc: gscData,
    reddit: {
      fetched: redditResult.success,
      totalMentions: redditResult.totalMentions || 0,
      subredditsFound: redditResult.subredditsFound || [],
      sentimentBreakdown: redditResult.sentimentBreakdown || {},
      topPosts: redditResult.posts || [],
      topSignals: redditResult.topSignals || [],
      d4SuggestedScore: d4Score ? d4Score.suggestedScore : null,
      note: redditResult.note || redditResult.error || null
    }
  };

  // ── CLAUDE PROMPT CONTEXTS ────────────────────────────────────────────────

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

  const gscContext = gscData.connected && gscData.siteUrl
    ? `GSC DATA AVAILABLE: Real Google Search Console data has been pulled for ${gscData.siteUrl}.
- Job pages found in GSC: ${(gscData.jobPageSearchAnalytics && gscData.jobPageSearchAnalytics.rowCount) || 0}
- Total impressions (90 days): ${(gscData.jobPageSearchAnalytics && gscData.jobPageSearchAnalytics.totalImpressions) || 0}
- Total clicks (90 days): ${(gscData.jobPageSearchAnalytics && gscData.jobPageSearchAnalytics.totalClicks) || 0}
Use this data to give precise, accurate D1 and D2 scores. Reference specific impression/click numbers in findings.`
    : `GSC DATA: Not connected. Score D1 and D2 based on schema and robots.txt/sitemap data only.`;

  // ── D4 CONTEXT FOR CLAUDE ─────────────────────────────────────────────────

  let d4Context;
  if (redditResult.success && redditResult.totalMentions > 0) {
    const { positive, negative, neutral } = redditResult.sentimentBreakdown;
    d4Context = `D4 REAL DATA — REDDIT EMPLOYER BRAND SIGNALS:
Reddit mentions found: ${redditResult.totalMentions}
Subreddits: ${redditResult.subredditsFound.join(', ') || 'none identified'}
Sentiment breakdown: ${positive} positive, ${negative} negative, ${neutral} neutral/mixed

Top posts (by Reddit score):
${redditResult.posts.map(p => `- [${p.sentiment.toUpperCase()}] "${p.title}" (r/${p.subreddit}, score: ${p.score}, comments: ${p.numComments})`).join('\n')}

Key signals:
${redditResult.topSignals.map(s => {
  if (s.type === 'negative') return `- NEGATIVE SIGNAL: ${s.count} negative post(s). Top: "${s.topPost}"`;
  if (s.type === 'positive') return `- POSITIVE SIGNAL: ${s.count} positive post(s). Top: "${s.topPost}"`;
  if (s.type === 'candidate_subreddit_presence') return `- CANDIDATE COMMUNITY PRESENCE: Mentioned in ${s.subreddits.join(', ')}`;
  return '';
}).join('\n')}

Suggested D4 score based on Reddit signals: ${d4Score ? d4Score.suggestedScore : 'N/A'}/100
You may adjust this score up or down based on additional context (industry norms, brand size, recency of posts, etc.).
The D4 dataSource field should be set to "reddit+real".
Reference specific post titles or subreddits in D4 findings.`;

  } else if (redditResult.success && redditResult.totalMentions === 0) {
    d4Context = `D4 REDDIT DATA: Reddit was searched successfully but no mentions of "${brand}" were found.
This may indicate the brand is small, niche, or not discussed publicly on Reddit.
Suggested D4 score: 45/100 (neutral baseline — absence of negative signal is not inherently bad).
Set D4 dataSource to "reddit+real" and note the absence of Reddit presence in findings.`;

  } else {
    d4Context = `D4 DATA: Reddit fetch failed (${redditResult.error || 'unknown error'}). No employer brand signal data is available. Return findings: ["Insufficient Data"] and score 50.
Set D4 dataSource to "insufficient".`;
  }

 const d5Context = (selectedATS && selectedATS.length > 0)
    ? `D5 ATS CONTEXT: The user has indicated they use the following ATS platform(s): ${selectedATS.join(', ')}.
For the D5 dimension, provide specific, actionable optimization tips tailored to these platforms. Cover:
- Any schema or structured data requirements specific to these ATSs
- Feed configuration settings that affect Google for Jobs eligibility
- Known indexing quirks or limitations that impact AI/LLM visibility
- Posting visibility or template settings candidates and crawlers commonly miss
- Any platform-specific best practices for maximizing distribution reach
Reference each selected ATS by name in the D5 findings. Be specific — not generic distribution advice.`
    : `D5 CONTEXT: No ATS platform selected. Provide general distribution coverage advice for D5.`;

  // ── PER-DIMENSION DATA AVAILABILITY FLAGS ────────────────────────────────
  // These are passed into the prompt so Claude knows exactly what data exists
  // for each dimension and cannot fabricate signals it was never given.

  const d1HasData = !!(jobAudits.some(j => j.fetchSuccess) || (gscData.connected && gscData.siteUrl));
  const d2HasData = !!(robotsAudit.found || sitemapAudit.found || (gscData.connected && gscData.siteUrl));
  const d3HasData = d3ScoredPages.length > 0;
  const d4HasData = redditResult.success;
  const d5HasData = !!(selectedATS && selectedATS.length > 0);

  // Schema.org signal: only mark ok/fail if we actually fetched a job page with schema
  const schemaSignalStatus = (() => {
    if (!jobAudits.some(j => j.fetchSuccess)) return 'na';
    const hasSchema = jobAudits.some(j => j.fetchSuccess && j.hasJobPostingSchema);
    return hasSchema ? 'ok' : 'fail';
  })();

  const systemPrompt = `You are the Cassillon AI GEO Audit Engine. You apply the Cassillon GEO Optimization Protocol to score employer brand and job posting visibility across five dimensions (D1–D5).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RULE — NO FABRICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You MUST NOT invent, assume, or hallucinate data for any dimension.

For each dimension, you are told explicitly what real data was collected.
- If real data exists → base ALL findings and scores on that data only.
- If real data does NOT exist → set the findings array to ["Insufficient Data"] and assign a neutral score of 50. Do NOT generate plausible-sounding findings. Do NOT reference Reddit, LinkedIn, Glassdoor, Indeed, or any external platform unless that platform's data was explicitly provided to you below.

The only data sources available to you are:
1. robots.txt and sitemap.xml — fetched directly from the domain (D1, D2)
2. JSON-LD schema extracted from job posting URLs provided by the user (D1, D3)
3. Google Search Console data — ONLY if GSC is marked as connected below (D1, D2)
4. Reddit RSS data — ONLY if Reddit fetch is marked as successful below (D4)
5. ATS platform selection — ONLY if the user selected ATS platforms below (D5)

You have NO access to LinkedIn, Glassdoor, Indeed, Bing, or any other external platform. Do not reference or score based on those platforms unless explicitly provided above.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATA AVAILABILITY PER DIMENSION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
D1 (Schema Integrity):     ${d1HasData ? 'REAL DATA AVAILABLE — see schema and GSC context below' : 'NO DATA — return ["Insufficient Data"], score 50'}
D2 (Career Site Hygiene):  ${d2HasData ? 'REAL DATA AVAILABLE — see robots.txt, sitemap, and GSC context below' : 'NO DATA — return ["Insufficient Data"], score 50'}
D3 (Job Posting Content):  ${d3HasData ? 'REAL DATA AVAILABLE — see D3 scored pages below' : 'NO DATA — return ["Insufficient Data"], score 50'}
D4 (Employer Brand):       ${d4HasData ? 'REAL DATA AVAILABLE — see Reddit context below' : 'NO DATA — return ["Insufficient Data"], score 50'}
D5 (Distribution):         ${d5HasData ? 'REAL DATA AVAILABLE — see ATS context below' : 'NO DATA — return ["Insufficient Data"], score 50'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REAL DATA PROVIDED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${gscContext}

${d3Context}

${d4Context}

${d5Context}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GEOPPROFILE METRICS AND SIGNALS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For geoProfile.metrics: derive values ONLY from real data above. If a metric has no data source, set its value to "Insufficient Data".
For geoProfile.signals: set status to "na" for any platform you have no real data about. Only set "ok", "warn", or "fail" for:
- "Schema.org JobPosting" — based on actual JSON-LD schema extracted (status: "${schemaSignalStatus}")
- "Google for Jobs" — only if GSC data was provided
Do NOT set ok/warn/fail for LinkedIn Jobs, Glassdoor, Indeed ATS Feed, or Bing Career Search — set all of those to "na".

Return ONLY valid JSON — no markdown, no preamble:
{
  "overallScore": 0-100,
  "scoreGrade": "Poor|Fair|Developing|Good|Strong|Excellent",
  "geoProfile": {
    "metrics": [
      {"label": "AI Citation Rate", "value": "derived from real data or Insufficient Data"},
      {"label": "LLM Visibility", "value": "derived from real data or Insufficient Data"},
      {"label": "Structured Data Coverage", "value": "derived from real schema audit or Insufficient Data"},
      {"label": "Brand Entity Strength", "value": "derived from real Reddit data or Insufficient Data"},
      {"label": "Distribution Index", "value": "derived from real ATS data or Insufficient Data"},
      {"label": "Content GEO Score", "value": "derived from real D3 scores or Insufficient Data"}
    ],
    "signals": [
      {"platform": "Google for Jobs", "status": "${(gscData.connected && gscData.siteUrl) ? 'ok|warn|fail' : 'na'}"},
      {"platform": "LinkedIn Jobs", "status": "na"},
      {"platform": "Glassdoor", "status": "na"},
      {"platform": "Indeed ATS Feed", "status": "na"},
      {"platform": "Schema.org JobPosting", "status": "${schemaSignalStatus}"},
      {"platform": "Bing Career Search", "status": "na"}
    ],
    "narrative": "3-4 sentence narrative based ONLY on the real audit data provided. Do not reference platforms or signals not backed by data."
  },
  "dimensions": [
    {
      "id": "D1",
      "name": "Schema Integrity",
      "score": ${d1HasData ? '0-100 based on real schema data' : '50'},
      "colorClass": "blue",
      "findings": ${d1HasData ? '["finding from real schema/GSC data", "finding 2", "finding 3"]' : '["Insufficient Data"]'},
      "dataSource": "${gscData.connected && gscData.siteUrl ? 'gsc+real' : (d1HasData ? 'real' : 'insufficient')}"
    },
    {
      "id": "D2",
      "name": "Career Site Hygiene",
      "score": ${d2HasData ? '0-100 based on real robots.txt/sitemap data' : '50'},
      "colorClass": "teal",
      "findings": ${d2HasData ? '["finding from real robots.txt/sitemap/GSC data", "finding 2", "finding 3"]' : '["Insufficient Data"]'},
      "dataSource": "${gscData.connected && gscData.siteUrl ? 'gsc+real' : (d2HasData ? 'real' : 'insufficient')}"
    },
    {
      "id": "D3",
      "name": "Job Posting Content",
      "score": ${d3HasData ? '0-100 based on real D3 scored pages' : '50'},
      "colorClass": "amber",
      "findings": ${d3HasData ? '["finding from real D3 signal scores", "finding 2", "finding 3"]' : '["Insufficient Data"]'},
      "dataSource": "${d3HasData ? 'real' : 'insufficient'}",
      "perUrlScores": ${d3HasData ? '[{"url": "string", "score": 0-100, "topGaps": ["signal name"]}]' : '[]'}
    },
    {
      "id": "D4",
      "name": "Employer Brand Signals",
      "score": ${d4HasData ? '0-100 based on real Reddit data' : '50'},
      "colorClass": "purple",
      "findings": ${d4HasData ? '["finding from real Reddit post titles/subreddits/sentiment", "finding 2", "finding 3"]' : '["Insufficient Data"]'},
      "dataSource": "${d4HasData ? 'reddit+real' : 'insufficient'}"
    },
    {
      "id": "D5",
      "name": "Distribution Coverage",
      "score": ${d5HasData ? '0-100 based on real ATS data' : '50'},
      "colorClass": "red",
      "findings": ${d5HasData ? '["finding from real ATS platform data", "finding 2", "finding 3"]' : '["Insufficient Data"]'},
      "dataSource": "${d5HasData ? 'ats+tips' : 'insufficient'}"
    }
  ],
  "internalActions": [
    {"title": "action title", "description": "specific actionable step referencing real findings — omit actions for dimensions with Insufficient Data", "effort": "Low|Medium|High", "impact": "High|Medium", "dimension": "D1"}
  ],
  "cassillonActions": [
    {"title": "service title", "description": "what Cassillon would deliver", "effort": "Low|Medium|High", "impact": "High|Medium"}
  ]
}

Provide exactly 5 internalActions and exactly 4 cassillonActions. Only reference real findings in actions — do not invent issues for dimensions that returned Insufficient Data.`;

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
  console.log(`Talent GEO backend v6 running on port ${PORT}`);
});
