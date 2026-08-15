# Alerting (T120, FR-043, SC-008)

There is no ops team to rediscover this, so the configuration lives in the repository and this file
is the record of what must exist in the project.

The chain is three pieces: the optimizer emits **structured logs**, a **log-based metric** counts
the bad ones, and an **alerting policy** emails the operator. Breaking any one of them makes a
failing system look like a quiet one.

## 1. The log fields the metric depends on

`packages/shared/src/logging.ts` writes Cloud Logging's structured format. Two fields are load
bearing and must not be renamed without updating the metric below:

- `severity` — `ERROR` for a failed cycle or an unhandled error
- `labels.component` — `optimizer` or `api`

Cycle outcomes are additionally recorded in Firestore (`cycles.outcome`), which is what
`GET /admin/cycles` reads. The alert deliberately keys on *logs* rather than on Firestore: if
Firestore itself is the failure, the log entry is the only signal left.

## 2. The log-based metric

```bash
PROJECT=easee-solar-charger

gcloud logging metrics create optimizer_cycle_failures \
  --project="$PROJECT" \
  --description="Optimizer cycles that failed or were skipped, and any ERROR from the optimizer" \
  --log-filter='
    resource.type="cloud_run_revision"
    resource.labels.service_name="easee-optimizer"
    (severity>=ERROR OR jsonPayload.outcome="failed" OR jsonPayload.outcome="skipped_locked")
  '
```

## 3. The alerting policy

Fires on **two or more occurrences in fifteen minutes**, not one. A single transient provider
failure is expected and is already handled by the fail-safe (FR-044); two in a row means the
fail-safe has become the steady state, which is the thing worth waking someone for.

```bash
gcloud alpha monitoring channels create \
  --project="$PROJECT" \
  --display-name="Operator email" \
  --type=email \
  --channel-labels=email_address=OPERATOR@EXAMPLE.COM
# note the returned channel id, then:

gcloud alpha monitoring policies create --project="$PROJECT" --policy-from-file=alert-policy.json
```

`alert-policy.json` in this directory is that policy, with the notification channel left as a
placeholder to be filled in once — the operator's email address is not repository content.

## 4. Verifying it

```bash
# Force a failing cycle against the deployed service and confirm the alert arrives.
curl -X POST "$OPTIMIZER_URL/cycle" -H 'Content-Type: application/json' -d '{"cycleId":"not-an-instant"}'
```

SC-008 requires the alert within fifteen minutes of the second failure. The policy's
`duration: 0s` with an alignment period of five minutes gives roughly one cycle of detection delay
plus the notification channel's own latency.
