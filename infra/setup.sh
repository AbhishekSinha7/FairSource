#!/usr/bin/env bash
# One-time setup of a FairSource Google Cloud project.
#   PROJECT=fs-dev ./infra/setup.sh
# Safe to re-run: "already exists" errors are ignored.
set -uo pipefail

PROJECT=${PROJECT:-fs-dev}
REGION=${REGION:-asia-south1}
BILLING_ALERT_USD=${BILLING_ALERT_USD:-50}
cd "$(dirname "$0")/.."

ok() { "$@" 2>&1 | grep -v -i 'already exists' || true; }

# Retries a command that can fail for a few seconds right after something is created
# (service agents appear with a delay; service-account creation is rate-limited per minute).
retry() {
  local n out
  for n in 1 2 3 4 5 6; do
    if out=$("$@" 2>&1); then return 0; fi
    if grep -qi 'already exists' <<<"$out"; then return 0; fi
    echo "  waiting to retry ($n/6): $(grep -m1 -io 'quota[^.]*\|does not exist[^.]*\|permission[^.]*' <<<"$out")"
    sleep 20
  done
  echo "$out" >&2
  return 1
}
PROJECT_NUMBER=""

gcloud config set project "$PROJECT"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

echo "== APIs"
gcloud services enable run.googleapis.com pubsub.googleapis.com firestore.googleapis.com \
  storage.googleapis.com bigquery.googleapis.com aiplatform.googleapis.com \
  cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com eventarc.googleapis.com

echo "== Firestore (Native mode)"
ok gcloud firestore databases create --location="$REGION"

echo "== Cloud Storage"
ok gcloud storage buckets create "gs://$PROJECT-raw" "gs://$PROJECT-clean" \
  --location="$REGION" --uniform-bucket-level-access --public-access-prevention
# Raw files move to Nearline after 30 days. Withdrawn posts are deleted by the cleanup job, not by age.
gcloud storage buckets update "gs://$PROJECT-raw" --lifecycle-file=infra/gcs-lifecycle.json

echo "== BigQuery ledger"
ok bq --location="$REGION" mk --dataset "$PROJECT:ledger"
bq --location="$REGION" query --use_legacy_sql=false < infra/ledger.sql

echo "== Pub/Sub"
for t in content.raw content.raw.dlq content.processed usage.events; do ok gcloud pubsub topics create "$t"; done
# Google's Pub/Sub service agent writes the ledger table for the BigQuery subscription.
gcloud beta services identity create --service=pubsub.googleapis.com --project="$PROJECT" >/dev/null 2>&1 || true
retry gcloud projects add-iam-policy-binding "$PROJECT" --condition=None \
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" --role=roles/bigquery.dataEditor
retry gcloud pubsub subscriptions create usage-to-bq --topic=usage.events \
  --bigquery-table="$PROJECT:ledger.usage_events" --use-table-schema

echo "== Artifact Registry"
ok gcloud artifacts repositories create services --repository-format=docker --location="$REGION"

echo "== Service accounts (one per service, no keys)"
for sa in ingest worker api mcp jobs scheduler pubsub; do
  if gcloud iam service-accounts describe "sa-$sa@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1; then continue; fi
  retry gcloud iam service-accounts create "sa-$sa" --display-name="FairSource $sa" && echo "  created sa-$sa"
  sleep 6 # stay under the per-minute creation quota
done
SA() { echo "serviceAccount:sa-$1@$PROJECT.iam.gserviceaccount.com"; }
bind() { gcloud projects add-iam-policy-binding "$PROJECT" --member="$(SA "$1")" --role="$2" --condition=None >/dev/null; }
bucket() { gcloud storage buckets add-iam-policy-binding "gs://$PROJECT-$1" --member="$(SA "$2")" --role="$3" >/dev/null; }
topic() { gcloud pubsub topics add-iam-policy-binding "$1" --member="$(SA "$2")" --role=roles/pubsub.publisher >/dev/null; }

bucket raw ingest roles/storage.objectUser        # write raw files, read and delete staged uploads
bucket clean ingest roles/storage.objectUser      # cleanup job deletes cleaned files of withdrawn posts
topic content.raw ingest
bind ingest roles/datastore.user
# Signed upload URLs: sa-ingest signs as itself (no key file).
gcloud iam service-accounts add-iam-policy-binding "sa-ingest@$PROJECT.iam.gserviceaccount.com" \
  --member="$(SA ingest)" --role=roles/iam.serviceAccountTokenCreator >/dev/null

bucket raw worker roles/storage.objectViewer
bucket clean worker roles/storage.objectCreator
topic content.processed worker
bind worker roles/aiplatform.user
bind worker roles/datastore.user

topic usage.events api
bind api roles/datastore.user
bind api roles/aiplatform.user
bind api roles/secretmanager.secretAccessor
bucket clean api roles/storage.objectViewer        # /v1/documents reads the cleaned article
# Shared secret for api /internal/restamp (called by the web app and ingest).
if ! gcloud secrets describe internal-token >/dev/null 2>&1; then
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create internal-token --data-file=- --replication-policy=user-managed --locations="$REGION"
fi

bind jobs roles/bigquery.dataEditor
bind jobs roles/bigquery.jobUser
bind jobs roles/datastore.user
bind jobs roles/secretmanager.secretAccessor
bucket raw jobs roles/storage.objectAdmin           # cleanup job deletes withdrawn files
bucket clean jobs roles/storage.objectAdmin
# Eventarc (upload-finalized trigger): sa-scheduler receives events; the Cloud Storage
# service agent must be able to publish them.
bind scheduler roles/eventarc.eventReceiver
GCS_AGENT=$(gcloud storage service-agent --project="$PROJECT")
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$GCS_AGENT" --role=roles/pubsub.publisher --condition=None
# sa-mcp gets roles/run.invoker on api, sa-scheduler on ingest, sa-pubsub on worker:
# granted per service after the first deploy (see README).

echo "== Firestore indexes"
# Vector index for licensed search: pre-filter servable + optOut, then nearest neighbour.
# --async: indexes build in the background for a few minutes; check with
#   gcloud firestore indexes composite list
ok gcloud firestore indexes composite create --async --collection-group=chunks --query-scope=COLLECTION \
  --field-config=order=ASCENDING,field-path=servable \
  --field-config=order=ASCENDING,field-path=optOut \
  --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}'
# Dashboard queries (web/lib/server/live.ts).
idx() { ok gcloud firestore indexes composite create --async --query-scope=COLLECTION "$@"; }
idx --collection-group=documents --field-config=order=ASCENDING,field-path=publisherId --field-config=order=DESCENDING,field-path=firstSeenAt   # Content page
idx --collection-group=documents --field-config=order=ASCENDING,field-path=publisherId --field-config=order=DESCENDING,field-path=processedAt   # Sources: latest item
idx --collection-group=earnings --field-config=order=ASCENDING,field-path=publisherId --field-config=order=ASCENDING,field-path=date             # Earnings chart
idx --collection-group=documentUsage --field-config=order=ASCENDING,field-path=publisherId --field-config=order=ASCENDING,field-path=month --field-config=order=DESCENDING,field-path=tokens   # Top articles
idx --collection-group=licences --field-config=order=ASCENDING,field-path=publisherId --field-config=order=DESCENDING,field-path=version         # Licence history
# "Recent uses" entries delete themselves after 7 days.
gcloud firestore fields ttls update expireAt --collection-group=recentUses --enable-ttl --quiet >/dev/null 2>&1 || true
# /v1/usage: a buyer's daily counters in a date range.
ok gcloud firestore indexes composite create --async --collection-group=buyerUsage --query-scope=COLLECTION \
  --field-config=order=ASCENDING,field-path=buyerId \
  --field-config=order=ASCENDING,field-path=date
# The deletion sweep reads documents by sourceIds (array-contains) and finds them by
# publisherId + sourceUrl; both use Firestore's automatic single-field indexes.

echo "== Done. Set a ${BILLING_ALERT_USD} USD budget alert in the console (Billing > Budgets)."
