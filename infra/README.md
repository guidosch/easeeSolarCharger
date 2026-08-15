# Infrastructure

Everything that runs is described here or in the files beside this one. There is no ops team to
rediscover a console setting, so a step that is not written down is a step that will be lost
(constitution, Technology & Deployment Constraints: "no configuration drift — what is in the
repository is what runs").

| File | What it is |
| --- | --- |
| `cloudrun/api.service.yaml` | the user + admin API service |
| `cloudrun/optimizer.service.yaml` | the five-minute cycle service |
| `scheduler/optimizer-cycle.sh` | the Cloud Scheduler job that drives it |
| `firestore/firestore.rules` | deny-all client access |
| `firestore/firestore.indexes.json` | the composite indexes the queries need |
| `firestore/ttl-policies.md` | the one-month TTL policies (FR-047) |
| `monitoring/` | the log-based metric and the email alerting policy (FR-043) |
| `../services/*/Dockerfile` | the two images |
| `../.github/workflows/deploy.yml` | deployment from `main`, via Workload Identity Federation |

## One-time setup

Everything below is done once, by hand, and never again. `deploy.yml` does the rest on every merge.

### 1. Project and APIs

```bash
PROJECT=solarpowerconsumptionoptimizer
REGION=europe-west6   # Zürich — the data is about a building in Switzerland

gcloud config set project "$PROJECT"
gcloud services enable \
  run.googleapis.com cloudscheduler.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com \
  iamcredentials.googleapis.com logging.googleapis.com monitoring.googleapis.com

gcloud artifacts repositories create services \
  --repository-format=docker --location="$REGION"
```

### 2. Firestore

```bash
gcloud firestore databases create --location="$REGION" --type=firestore-native

pnpm dlx firebase-tools deploy --only firestore:rules,firestore:indexes --project "$PROJECT"
```

Then apply the TTL policies — they are not part of `firestore.indexes.json` and must be set
separately. See [`firestore/ttl-policies.md`](firestore/ttl-policies.md).

### 3. Secrets

Nothing here is ever committed. Committing a secret is a violation that requires **rotation**, not
just removal (Principle V).

```bash
for SECRET in easee-technical-username easee-technical-password \
              solaredge-api-key solaredge-site-id openweather-api-key admin-password; do
  gcloud secrets create "$SECRET" --replication-policy=automatic
  printf '%s' "$VALUE" | gcloud secrets versions add "$SECRET" --data-file=-
done
```

The Easee credentials are for the **dedicated technical account** the optimizer uses, not a
person's account (research R6). Its token is cached in `providerTokens/easeeTechnical` because it
rotates hourly; the credentials that mint it stay here.

### 4. Service accounts

Three identities, each with the least it needs. In particular the API is *not* given the
optimizer's permissions: merging the two services would hand the public API the ability to command
chargers, which is why they are separate deployables at all.

```bash
gcloud iam service-accounts create easee-api
gcloud iam service-accounts create easee-optimizer
gcloud iam service-accounts create easee-scheduler

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:easee-api@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/datastore.user
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:easee-optimizer@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/datastore.user

# Each service reads only its own secrets.
gcloud secrets add-iam-policy-binding admin-password \
  --member="serviceAccount:easee-api@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
for SECRET in easee-technical-username easee-technical-password \
              solaredge-api-key solaredge-site-id openweather-api-key; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:easee-optimizer@$PROJECT.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done

# The optimizer is not a public endpoint: only the scheduler may invoke it.
gcloud run services add-iam-policy-binding easee-optimizer --region="$REGION" \
  --member="serviceAccount:easee-scheduler@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/run.invoker
```

### 5. The cycle

```bash
./scheduler/optimizer-cycle.sh
```

Five minutes, Europe/Zurich, OIDC, `min-backoff` 60 s and **retries 0**. A missed cycle is
preferable to a stacked one: the next cycle is five minutes away and sees the same world, whereas a
retry queues a second attempt behind one that may still be running (research R7).

### 6. Alerting

See [`monitoring/README.md`](monitoring/README.md). Two failures in fifteen minutes emails the
operator; one does not, because a single transient provider failure is expected and is already
handled by the fail-safe.

### 7. Workload Identity Federation for CI

No service-account key ever enters the repository.

```bash
gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository=='OWNER/easeeSolarCharger'"

gcloud iam service-accounts create easee-deployer
gcloud iam service-accounts add-iam-policy-binding \
  "easee-deployer@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/OWNER/easeeSolarCharger"
```

### 8. Hosting

The two static bundles are served by Firebase Hosting rather than Cloud Storage — **deviation D2**
in `plan.md`, because Cloud Storage cannot serve HTTPS on a custom domain without a load balancer
that has no free tier and would cost more than everything else here combined. That deviation is the
subject of the constitution amendment to v2.2.0, which the owner adopts by merging it.

Two sites, because the admin bundle must never be shipped to end users' phones — it is both wasteful
and an information leak. The default site comes with the project; the second one has to be created
before a target can point at it.

```bash
pnpm dlx firebase-tools hosting:sites:create "$PROJECT-admin" --project "$PROJECT"

# Bind the targets named in firebase.json to the two sites. `.firebaserc` records the result, so
# this is only needed on a fresh checkout that has lost it.
pnpm dlx firebase-tools target:apply hosting web "$PROJECT" --project "$PROJECT"
pnpm dlx firebase-tools target:apply hosting admin "$PROJECT-admin" --project "$PROJECT"

pnpm build
pnpm dlx firebase-tools deploy --only hosting --project "$PROJECT"
```

#### The `/api/**` rewrite

Both sites rewrite `/api/**` to the `easee-api` Cloud Run service before the SPA catch-all, so the
frontends call their own origin and there is no CORS preflight on every request and no second
hostname to configure per environment. **The order in `firebase.json` matters**: a catch-all placed
first would swallow `/api/**` and hand the PWA an HTML page where it expected JSON — which fails at
runtime in production only, since the Vite dev server proxies `/api` itself.

That rewrite requires the Hosting service agent to be able to invoke the API:

```bash
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
gcloud run services add-iam-policy-binding easee-api --region="$REGION" \
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-firebasehosting.iam.gserviceaccount.com" \
  --role=roles/run.invoker
```

#### Custom domains (optional)

Free managed HTTPS, which is the whole reason for the deviation:

```bash
pnpm dlx firebase-tools hosting:sites:list --project "$PROJECT"
# then add the domain in the console or with `firebase hosting:channel`, and follow the DNS records
# it gives you. Certificates are issued and renewed automatically.
```

## Rollout to the hardware

The only real hardware is the owner's own parking lot. The sequence, from
[`quickstart.md`](../specs/001-solar-charging-mvp/quickstart.md):

1. `pnpm cycle:dry-run --lot=<owner-lot>` — computes the decision and writes nothing.
2. Seed `parkingLots` with the owner's lot **only**, and let the cycle run for a full session.
3. Watch `GET /api/admin/chargers/<lot>/trace`.
4. Only then widen the mapping to the other 29 lots.
