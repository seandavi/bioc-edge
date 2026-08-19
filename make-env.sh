#!/usr/bin/env bash
#
# Populate .env from Google Secret Manager. Run once per machine:
#
#   ./make-env.sh && set -a && . ./.env && set +a
#
# .env is gitignored. Secrets live in Secret Manager, never in the repo, so
# there is nothing to rotate here when a token changes -- just re-run this.
set -euo pipefail

project=${GCP_PROJECT:-cdsci-infra}
get() { gcloud secrets versions access latest --secret="$1" --project="$project"; }

umask 077
{
  # Machine-specific: the mirror is far too large for a home directory once
  # phase 3 (188 GB) is in play, so it lives on bulk storage.
  echo "DEST=${DEST:-/data/davsean/bioc-cloudflare/mirror}"
  echo "CLOUDFLARE_ACCOUNT_ID=$(get cdsci-r2-account-id)"
  # Workers token deploys the Worker. R2 bucket administration is a separate
  # permission it does not carry -- use rclone (S3 API) for bucket work.
  echo "CLOUDFLARE_API_TOKEN=$(get cdsci-cloudflare-workers-token)"
  # The rrsync-restricted upstream source. sync.sh treats an unset RSYNC_SRC
  # as "crawl only" rather than as an error, so a missing value here stops the
  # pull silently -- which is exactly why it belongs in Secret Manager.
  echo "RSYNC_SRC=$(get cdsci-bioc-site-rsync-src)"
} > .env

echo "wrote .env with $(grep -c '=' .env) variables"
