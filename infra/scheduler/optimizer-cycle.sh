#!/usr/bin/env bash
# The five-minute optimizer cycle (T137, research R7).
#
# Two settings are load bearing:
#
#   --max-retry-attempts=0  A missed cycle is preferable to a stacked one. The next cycle is five
#                           minutes away and will see the same world; a retry would queue a second
#                           attempt behind one that may still be running.
#   --min-backoff=60s       Belt and braces if retries are ever enabled by hand.
#
# The body carries `cycleId`, the scheduled instant, which is also the idempotency key (FR-050):
# an at-least-once delivery of the same instant overwrites its own record rather than acting twice.
set -euo pipefail

PROJECT="${PROJECT:-easee-solar-charger}"
REGION="${REGION:-europe-west6}"
OPTIMIZER_URL="$(gcloud run services describe easee-optimizer \
  --project="$PROJECT" --region="$REGION" --format='value(status.url)')"

gcloud scheduler jobs create http optimizer-cycle \
  --project="$PROJECT" \
  --location="$REGION" \
  --schedule="*/5 * * * *" \
  --time-zone="Europe/Zurich" \
  --uri="${OPTIMIZER_URL}/cycle" \
  --http-method=POST \
  --headers="Content-Type=application/json" \
  --message-body='{"cycleId":"__SCHEDULED_INSTANT__"}' \
  --oidc-service-account-email="easee-scheduler@${PROJECT}.iam.gserviceaccount.com" \
  --oidc-token-audience="${OPTIMIZER_URL}" \
  --max-retry-attempts=0 \
  --min-backoff=60s \
  --attempt-deadline=180s

# Cloud Scheduler does not template the scheduled instant into the body, so the optimizer treats a
# literal `__SCHEDULED_INSTANT__` as "the current instant, floored to the cycle cadence" — which
# gives the same idempotency key for every delivery of the same scheduled run.
