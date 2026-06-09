# Talent GEO — MVP

AI-powered employer brand and job posting visibility audit tool, built by Cassillon AI. Talent GEO scores how well a company appears in AI-mediated candidate search across five dimensions, and delivers a prioritized action roadmap to fix what's broken.

---

## What It Does

Users enter their company domain, brand name, industry, and up to three job posting URLs. The tool fetches live data from the career site — including JSON-LD schema, robots.txt, sitemap.xml, and job posting content — then passes it through the Cassillon GEO Optimization Protocol powered by Claude. The result is a structured audit report with:

- **Section A:** GEO profile with per-platform signal status and dimension scores (D1–D5)
- **Section B:** Prioritized internal fix roadmap with effort/impact tags
- **Section C:** Cassillon service offerings mapped to the audit findings

---

## The Five Dimensions

| ID | Dimension | What It Checks |
|----|-----------|----------------|
| D1 | Schema Integrity | JSON-LD JobPosting markup, Google Rich Results validation |
| D2 | Career Site Hygiene | Crawler access, sitemap, site structure |
| D3 | Job Posting Content Structure | Content quality for AI parsing |
| D4 | Employer Brand Signal Strength | Presence across AI-indexed platforms |
| D5 | Distribution & Monitoring | Job board reach and tracking setup |

---

## Repo Structure

```
TalentGEO/
├── frontend/
│   └── index.html        # Single-page app (HTML/CSS/JS)
├── backend/
│   ├── server.js         # Express proxy + audit engine
│   ├── package.json
│   └── Dockerfile        # Node.js container for Cloud Run
└── README.md
```

---

## Architecture

```
User Browser
    │
    ▼
Firebase Hosting  ←─ frontend/index.html (static)
    │
    │  POST /audit
    ▼
Cloud Run (backend)  ←─ Holds ANTHROPIC_API_KEY via Secret Manager
    │
    │  Fetches live data: schema, robots.txt, sitemap, job pages
    │
    ▼
Anthropic API (Claude Sonnet)
    │
    ▼
Structured JSON report  ──▶  rendered in browser
```

- **Frontend:** Static HTML/CSS/JS served from Cloud Run (nginx) or Firebase Hosting
- **Backend:** Node.js/Express on Cloud Run, scales to zero when idle
- **AI Engine:** Claude Sonnet via Anthropic API — not a chatbot, the scoring/analysis engine
- **Secrets:** Anthropic API key stored in GCP Secret Manager, injected at runtime

---

## Local Development

### Prerequisites

- Node.js 18+
- An Anthropic API key

### Run the backend

```bash
cd backend
npm install
ANTHROPIC_API_KEY=sk-ant-your-key-here node server.js
```

The backend runs on `http://localhost:8080` by default.

### Run the frontend

Open `frontend/index.html` directly in a browser, or serve it with any static file server:

```bash
npx serve frontend
```

Make sure the `BACKEND_URL` constant near the bottom of `index.html` points to your local backend (`http://localhost:8080`) for local testing.

---

## Deployment (Google Cloud)

The app is deployed on GCP using Cloud Run for both frontend and backend, with continuous deployment triggered from commits to `main`.

### First-time setup

**1. Enable GCP APIs**

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
```

**2. Store the Anthropic API key**

```bash
echo -n "sk-ant-YOUR_KEY_HERE" | \
  gcloud secrets create ANTHROPIC_API_KEY --data-file=- --replication-policy="automatic"
```

**3. Deploy the backend**

```bash
cd backend
gcloud run deploy talentgeo-backend \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets="ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest" \
  --memory 512Mi \
  --timeout 120
```

Copy the service URL from the output (e.g. `https://talentgeo-backend-XXXXXXXX-uc.a.run.app`).

**4. Update the frontend**

In `frontend/index.html`, set `BACKEND_URL` to the Cloud Run URL from step 3.

**5. Deploy the frontend**

```bash
cd frontend
gcloud run deploy talentgeo-frontend \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 256Mi
```

### Continuous deployment

Cloud Build triggers are configured for both services. Every commit to `main` automatically rebuilds and redeploys. Build logs are visible in **Cloud Console → Cloud Build → History**.

---

## Live URLs

| Service | URL |
|---------|-----|
| Frontend | `https://talentgeo-frontend-XXXXXXXX-uc.a.run.app` |
| Backend | `https://talentgeo-backend-360027703478.us-central1.run.app` |

> Update this table with your actual URLs after deployment.

---

## Environment Variables

| Variable | Where Set | Description |
|----------|-----------|-------------|
| `ANTHROPIC_API_KEY` | GCP Secret Manager | Claude API key |
| `PORT` | Cloud Run (auto) | HTTP port, defaults to 8080 |

---

## Status & Roadmap

This is an MVP. Core audit functionality is live. Planned next phases:

- [ ] Google Search Console API integration (D1/D2 real signals)
- [ ] PDF report export (Puppeteer on Cloud Run)
- [ ] Email delivery of report (SendGrid/Mailgun)
- [ ] User accounts and report history (Firebase Auth + Firestore)
- [ ] Tier gating / Stripe paywall
- [ ] Process Cards (auto-generated by Claude when Fix Cards are completed)
- [ ] Glassdoor / LinkedIn / Reddit signal fetching (D4)

---

## Built By

[Cassillon AI](https://cassillon.com) — Talent Acquisition Operations consulting and tooling.
