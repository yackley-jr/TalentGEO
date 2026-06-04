#!/bin/bash
# ============================================================
# Talent GEO — Full Deployment Guide
# Run these commands one section at a time in Google Cloud Shell
# or your local terminal with gcloud CLI installed.
# ============================================================

# ── STEP 0: Prerequisites ───────────────────────────────────
# Make sure you have:
#   - A Google Cloud project with billing enabled
#   - gcloud CLI installed and authenticated: gcloud auth login
#   - Docker installed (only needed for local testing)

# Set your project ID (replace with your actual project ID)
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export SERVICE_NAME="talentgeo-backend"

gcloud config set project $PROJECT_ID


# ── STEP 1: Enable required GCP APIs ────────────────────────
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com


# ── STEP 2: Store your Anthropic API key in Secret Manager ──
# Replace sk-ant-... with your actual Anthropic API key
echo -n "sk-ant-YOUR_ACTUAL_API_KEY_HERE" | \
  gcloud secrets create ANTHROPIC_API_KEY \
    --data-file=- \
    --replication-policy="automatic"

# Verify it was stored:
# gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY


# ── STEP 3: Deploy the backend to Cloud Run ─────────────────
# Navigate to the backend folder first:
#   cd talentgeo/backend

# This single command builds the container and deploys it.
# Cloud Build handles the Docker build — no local Docker needed.
gcloud run deploy $SERVICE_NAME \
  --source . \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets="ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest" \
  --memory 512Mi \
  --cpu 1 \
  --timeout 120 \
  --min-instances 0 \
  --max-instances 10

# After deployment completes, Cloud Run will print your service URL.
# It looks like: https://talentgeo-backend-XXXXXXXX-uc.a.run.app
# Copy that URL — you need it in Step 4.


# ── STEP 4: Update the frontend with your backend URL ───────
# Open talentgeo/frontend/index.html in any text editor.
# Find this line near the bottom of the <script> section:
#
#   const BACKEND_URL = 'REPLACE_WITH_YOUR_CLOUD_RUN_URL';
#
# Replace it with your actual Cloud Run URL, for example:
#
#   const BACKEND_URL = 'https://talentgeo-backend-abc123-uc.a.run.app';
#
# Save the file.


# ── STEP 5: Deploy the frontend to Cloud Run ────────────────
# The frontend is a static HTML file. We serve it with a tiny
# nginx container — no separate hosting service needed.

# Navigate to the frontend folder:
#   cd talentgeo/frontend

# Create a minimal nginx Dockerfile inline:
cat > Dockerfile << 'EOF'
FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
EXPOSE 8080
CMD sed -i 's/listen       80/listen       8080/' /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'
EOF

# Deploy the frontend
gcloud run deploy talentgeo-frontend \
  --source . \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 256Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 5

# Cloud Run will print your frontend URL.
# Example: https://talentgeo-frontend-XXXXXXXX-uc.a.run.app
# This is your live Talent GEO app — accessible from the internet
# with HTTPS already enabled. No certificate setup required.


# ── STEP 6: Test it ─────────────────────────────────────────
# 1. Open the frontend URL in your browser
# 2. Enter a domain (e.g. greenhouse.io) and brand name
# 3. Click Run GEO Audit
# 4. You should see the animated loading screen and then the report

# Test the backend directly:
# curl https://YOUR-BACKEND-URL.run.app/
# Should return: {"status":"ok","service":"Talent GEO Audit API"}

# Test an audit call:
# curl -X POST https://YOUR-BACKEND-URL.run.app/audit \
#   -H "Content-Type: application/json" \
#   -d '{"domain":"greenhouse.io","brand":"Greenhouse","industry":"Technology"}'


# ── OPTIONAL: Custom domain (future) ────────────────────────
# When you're ready to attach a custom domain like talentgeo.cassillon.com:
#
# 1. Buy the domain via Google Domains, Namecheap, etc.
# 2. In Cloud Run console → your service → Custom Domains → Add Mapping
# 3. Follow the DNS verification steps (add a TXT record to your domain)
# 4. Cloud Run auto-provisions a free SSL certificate (Let's Encrypt)
# No manual certificate work required.


# ── UPDATING THE APP ────────────────────────────────────────
# Backend change: edit server.js, then re-run the gcloud run deploy command
# Frontend change: edit index.html, then re-run the frontend deploy command
# Both redeploy in ~60 seconds with zero downtime.
