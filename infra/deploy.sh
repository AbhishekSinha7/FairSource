#!/usr/bin/env bash
# Builds and deploys FairSource to Cloud Run, then wires the services together.
# Run in Cloud Shell from the repo root, after infra/setup.sh:
#
#   PROJECT=my-project \
#   FIREBASE_API_KEY=AIza...            # Firebase console -> Project settings -> Your apps -> Web app
#   GEMINI_API_KEY=...                  # optional; without it Gemini runs on Vertex AI (location "global")
#   ADMIN_EMAIL=you@gmail.com           # optional; links this Google account as a publisher
#   bash infra/deploy.sh
#
# Safe to run again: it rebuilds, redeploys and updates the wiring in place.
set -euo pipefail

PROJECT=${PROJECT:?Set PROJECT to your Google Cloud project ID}
FIREBASE_API_KEY=${FIREBASE_API_KEY:?Set FIREBASE_API_KEY (Firebase console > Project settings > Your apps > Web app > apiKey)}
REGION=${REGION:-asia-south1}
GEMINI_API_KEY=${GEMINI_API_KEY:-}
ADMIN_EMAIL=${ADMIN_EMAIL:-}
ORG_ID=${ORG_ID:-pub_example}
ORG_NAME=${ORG_NAME:-Example Marathi Daily}
MIN_API_INSTANCES=${MIN_API_INSTANCES:-0}
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }
SA() { echo "sa-$1@$PROJECT.iam.gserviceaccount.com"; }
quiet() { "$@" >/dev/null 2>&1; }
bind() { gcloud projects add-iam-policy-binding "$PROJECT" --member="$1" --role="$2" --condition=None >/dev/null; }

gcloud config set project "$PROJECT" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
PUBSUB_AGENT="service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com"
REPO="$REGION-docker.pkg.dev/$PROJECT/services"
TAG=$(date +%Y%m%d-%H%M%S)

say "APIs for deploying and for Firebase Auth"
gcloud services enable cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com \
  iamcredentials.googleapis.com identitytoolkit.googleapis.com firebase.googleapis.com >/dev/null

say "Secrets"
if [ -n "$GEMINI_API_KEY" ]; then
  if ! quiet gcloud secrets describe gemini-api-key; then
    gcloud secrets create gemini-api-key --replication-policy=user-managed --locations="$REGION" >/dev/null
  fi
  printf '%s' "$GEMINI_API_KEY" | gcloud secrets versions add gemini-api-key --data-file=- >/dev/null
  echo "  gemini-api-key updated"
fi
if quiet gcloud secrets describe gemini-api-key; then
  GEMINI="secret"
  for s in worker api; do
    gcloud secrets add-iam-policy-binding gemini-api-key --member="serviceAccount:$(SA $s)" --role=roles/secretmanager.secretAccessor >/dev/null
  done
  echo "  Gemini: API key from Secret Manager"
else
  GEMINI="vertex"
  echo "  Gemini: Vertex AI (no GEMINI_API_KEY given)"
fi

say "Dashboard service account"
if ! quiet gcloud iam service-accounts describe "$(SA web)"; then
  gcloud iam service-accounts create sa-web --display-name="FairSource web" >/dev/null
  sleep 10
fi
bind "serviceAccount:$(SA web)" roles/datastore.user
bind "serviceAccount:$(SA web)" roles/firebaseauth.admin
gcloud secrets add-iam-policy-binding internal-token --member="serviceAccount:$(SA web)" --role=roles/secretmanager.secretAccessor >/dev/null

say "Cloud Build permissions"
BUILD_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for role in roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do bind "serviceAccount:$BUILD_SA" "$role"; done

say "Building 5 images in Cloud Build (about 5-10 minutes; logs in console > Cloud Build)"
build() { # name dockerfile build-args
  gcloud builds submit . --config infra/build-image.yaml --region="$REGION" --quiet \
    --substitutions="^@^_DOCKERFILE=$2@_IMAGE=$REPO/$1:$TAG@_BUILD_ARGS=$3" >"/tmp/fs-build-$1.log" 2>&1
}
declare -A PIDS
for svc in ingest api mcp; do build "$svc" services/Dockerfile.node "--build-arg SERVICE=$svc" & PIDS[$svc]=$!; done
build worker services/worker/Dockerfile "" & PIDS[worker]=$!
build web web/Dockerfile "--build-arg NEXT_PUBLIC_FIREBASE_API_KEY=$FIREBASE_API_KEY --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$PROJECT.firebaseapp.com --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID=$PROJECT" & PIDS[web]=$!
FAILED=""
for svc in "${!PIDS[@]}"; do
  if wait "${PIDS[$svc]}"; then echo "  built $svc"; else echo "  FAILED $svc (see /tmp/fs-build-$svc.log)"; FAILED="$FAILED $svc"; fi
done
if [ -n "$FAILED" ]; then
  echo; echo "Build failed for:$FAILED"
  for svc in $FAILED; do echo "--- last lines of /tmp/fs-build-$svc.log"; tail -25 "/tmp/fs-build-$svc.log"; done
  exit 1
fi

say "Deploying to Cloud Run ($REGION)"
COMMON_ENV="GOOGLE_CLOUD_PROJECT=$PROJECT,RAW_BUCKET=$PROJECT-raw,CLEAN_BUCKET=$PROJECT-clean"
if [ "$GEMINI" = secret ]; then GEMINI_ENV=""; GEMINI_SECRET="GEMINI_API_KEY=gemini-api-key:latest"
else GEMINI_ENV=",GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_LOCATION=global"; GEMINI_SECRET=""; fi
deploy() { gcloud run deploy "$@" --region="$REGION" --quiet >/dev/null; echo "  deployed $1"; }
url() { gcloud run services describe "$1" --region="$REGION" --format='value(status.url)'; }

deploy ingest --image="$REPO/ingest:$TAG" --service-account="$(SA ingest)" --no-allow-unauthenticated \
  --timeout=300 --no-cpu-throttling --memory=1Gi --max-instances=5 --concurrency=10 \
  --set-env-vars="$COMMON_ENV"
deploy worker --image="$REPO/worker:$TAG" --service-account="$(SA worker)" --no-allow-unauthenticated \
  --timeout=600 --concurrency=4 --cpu=2 --memory=2Gi --max-instances=20 \
  --set-env-vars="$COMMON_ENV$GEMINI_ENV" ${GEMINI_SECRET:+--set-secrets=$GEMINI_SECRET}
deploy api --image="$REPO/api:$TAG" --service-account="$(SA api)" --allow-unauthenticated \
  --min-instances="$MIN_API_INSTANCES" --max-instances=20 --concurrency=40 \
  --set-env-vars="$COMMON_ENV$GEMINI_ENV" --set-secrets="INTERNAL_TOKEN=internal-token:latest${GEMINI_SECRET:+,$GEMINI_SECRET}"
INGEST_URL=$(url ingest); WORKER_URL=$(url worker); API_URL=$(url api)
gcloud run services update api --region="$REGION" --update-env-vars="PUBLIC_API_URL=$API_URL" --quiet >/dev/null
deploy mcp --image="$REPO/mcp:$TAG" --service-account="$(SA mcp)" --allow-unauthenticated \
  --max-instances=10 --set-env-vars="API_BASE=$API_URL"
deploy web --image="$REPO/web:$TAG" --service-account="$(SA web)" --allow-unauthenticated \
  --memory=1Gi --max-instances=5 \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,DATA_BACKEND=firestore,INGEST_URL=$INGEST_URL,API_URL=$API_URL" \
  --set-secrets="INTERNAL_TOKEN=internal-token:latest"
MCP_URL=$(url mcp); WEB_URL=$(url web)

say "Wiring: who may call the private services"
invoker() { gcloud run services add-iam-policy-binding "$1" --region="$REGION" --member="serviceAccount:$(SA "$2")" --role=roles/run.invoker >/dev/null; }
invoker ingest scheduler   # Cloud Scheduler and the upload trigger
invoker ingest web         # Sync now, feed discovery, upload URLs
invoker worker pubsub      # Pub/Sub pushes content.raw

say "Wiring: content.raw -> worker (Pub/Sub push with dead-letter)"
gcloud iam service-accounts add-iam-policy-binding "$(SA pubsub)" --member="serviceAccount:$PUBSUB_AGENT" --role=roles/iam.serviceAccountTokenCreator >/dev/null
gcloud pubsub topics add-iam-policy-binding content.raw.dlq --member="serviceAccount:$PUBSUB_AGENT" --role=roles/pubsub.publisher >/dev/null
SUB_FLAGS=(--push-endpoint="$WORKER_URL/" --push-auth-service-account="$(SA pubsub)" --ack-deadline=600
  --min-retry-delay=10s --max-retry-delay=600s --dead-letter-topic=content.raw.dlq --max-delivery-attempts=5)
if quiet gcloud pubsub subscriptions describe content-raw-worker; then
  gcloud pubsub subscriptions update content-raw-worker "${SUB_FLAGS[@]}" >/dev/null
else
  gcloud pubsub subscriptions create content-raw-worker --topic=content.raw "${SUB_FLAGS[@]}" >/dev/null
fi
gcloud pubsub subscriptions add-iam-policy-binding content-raw-worker --member="serviceAccount:$PUBSUB_AGENT" --role=roles/pubsub.subscriber >/dev/null
echo "  content-raw-worker -> $WORKER_URL"

say "Wiring: schedules (every 5 minutes; daily sweep at 03:00 IST)"
job() { # name schedule path
  local flags=(--location="$REGION" --schedule="$2" --uri="$INGEST_URL$3" --http-method=POST --attempt-deadline=300s
    --oidc-service-account-email="$(SA scheduler)" --oidc-token-audience="$INGEST_URL" --time-zone=Etc/UTC)
  if quiet gcloud scheduler jobs describe "$1" --location="$REGION"; then gcloud scheduler jobs update http "$1" "${flags[@]}" >/dev/null
  else gcloud scheduler jobs create http "$1" "${flags[@]}" >/dev/null; fi
  echo "  $1: $2 -> $3"
}
job run-sources "*/5 * * * *" /internal/run-due
job sweep-sources "30 21 * * *" /internal/sweep

say "Wiring: uploads -> ingest (Eventarc)"
if ! quiet gcloud eventarc triggers describe upload-finalized --location="$REGION"; then
  gcloud eventarc triggers create upload-finalized --location="$REGION" \
    --destination-run-service=ingest --destination-run-region="$REGION" --destination-run-path=/internal/upload-finalized \
    --event-filters=type=google.cloud.storage.object.v1.finalized --event-filters=bucket="$PROJECT-raw" \
    --service-account="$(SA scheduler)" >/dev/null
fi
echo "  upload-finalized on gs://$PROJECT-raw"

if [ -n "$ADMIN_EMAIL" ]; then
  say "Linking $ADMIN_EMAIL as publisher $ORG_ID"
  [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null 2>&1
  npm run build -w packages/shared >/dev/null
  GOOGLE_CLOUD_QUOTA_PROJECT="$PROJECT" npx --yes tsx infra/create-org.ts --project "$PROJECT" --role publisher \
    --id "$ORG_ID" --name "$ORG_NAME" --email "$ADMIN_EMAIL" --city Pune --languages mr,hi,en
fi

cat <<EOF

== Done
  Dashboard  $WEB_URL
  API        $API_URL      (docs: $WEB_URL/docs)
  MCP        $MCP_URL/mcp
  Ingest     $INGEST_URL   (private)
  Worker     $WORKER_URL   (private)

Last step, once: Firebase console > Authentication > Settings > Authorized domains > Add domain:
  ${WEB_URL#https://}
Then open the dashboard, choose Live and sign in with Google.
EOF
