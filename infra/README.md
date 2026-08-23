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

## Activate GCP Project

```bash
gcloud config set project solarpowerconsumptionoptimizer

# check logged in user and available configs/projects
gcloud auth list
gcloud config list
gcloud projects list
```


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
  iamcredentials.googleapis.com logging.googleapis.com monitoring.googleapis.com \
  firebase.googleapis.com firebasehosting.googleapis.com firebaserules.googleapis.com

gcloud artifacts repositories create services \
  --repository-format=docker --location="$REGION"
```

### 2. Firestore

```bash
gcloud firestore databases create --location="$REGION" --type=firestore-native

pnpm dlx firebase-tools login # login to firebase

# Enabling the APIs is not enough: a plain GCP project is not a Firebase project until it is
# registered, and the Firebase resources (default Hosting site, Firebase-side project record) only
# exist afterwards. Skipping this makes every later firebase-tools call fail with a bare
# `HTTP Error: 404, Requested entity was not found` that names no missing entity.
pnpm dlx firebase-tools projects:addfirebase "$PROJECT"

pnpm dlx firebase-tools deploy --only firestore:rules,firestore:indexes --project "$PROJECT"
```

That deploy also applies the one-month TTL policies: they are declared as `fieldOverrides` with
`"ttl": true` in `firestore.indexes.json`. See [`firestore/ttl-policies.md`](firestore/ttl-policies.md)
for why they must stay declared there.

### 3. Secrets

Nothing here is ever committed. Committing a secret is a violation that requires **rotation**, not
just removal (Principle V).

The loop prompts for each value. `read -rs` keeps it off the screen and out of shell history, and
`printf '%s'` writes it without a trailing newline — a `\n` would be part of the secret and would
fail the provider login with a 401 that looks like a wrong password. The `describe` guard makes the
loop re-runnable after a partial run.

```bash
for SECRET in easee-technical-username easee-technical-password \
              solaredge-api-key solaredge-site-id openweather-api-key admin-password; do
  gcloud secrets describe "$SECRET" >/dev/null 2>&1 || \
    gcloud secrets create "$SECRET" --replication-policy=automatic
  printf 'Value for %s: ' "$SECRET" >&2
  read -rs VALUE; echo >&2
  printf '%s' "$VALUE" | gcloud secrets versions add "$SECRET" --data-file=-
done
unset VALUE
```

Every secret must end up with exactly one enabled version; a secret with none is created but unusable
and only fails later, at deploy time:

```bash
for SECRET in easee-technical-username easee-technical-password \
              solaredge-api-key solaredge-site-id openweather-api-key admin-password; do
  printf '%s: %s enabled version(s)\n' "$SECRET" \
    "$(gcloud secrets versions list "$SECRET" --filter='state=ENABLED' --format='value(name)' | wc -l | tr -d ' ')"
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
```

The scheduler's `run.invoker` binding on the optimizer is **not** here: it names a Cloud Run
service, and no service exists until the first deploy has run. See
[step 9](#9-after-the-first-deploy).

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

The two values below are placeholders in no way: paste them as they are. An `OWNER` or
`PROJECT_NUMBER` left literal produces `unauthorized_client: The given credential is rejected by the
attribute condition`, an error that names neither the condition nor the value that failed it.

```bash
REPO=guidosch/easeeSolarCharger
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository=='$REPO'"

gcloud iam service-accounts create easee-deployer
# Without this binding the federated token is minted and then refused at impersonation, one step
# later than the condition failure above and with an equally unhelpful message.
gcloud iam service-accounts add-iam-policy-binding \
  "easee-deployer@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"

# What `deploy.yml` actually does: push two images, replace two services, deploy hosting, rules and
# indexes. `serviceAccountUser` is the one that is easy to forget — deploying a service that runs as
# `easee-api`/`easee-optimizer` means acting as those identities, and without it the deploy fails on
# the `gcloud run services replace` step with a permission error that names neither role.
# `firebaserules.admin` and `datastore.indexAdmin` are separate grants because `--only
# firestore:rules` and `--only firestore:indexes` are separate permissions; having one and not the
# other fails halfway through a single `firebase deploy`.
for ROLE in roles/artifactregistry.writer roles/run.admin roles/iam.serviceAccountUser \
            roles/firebasehosting.admin roles/datastore.indexAdmin \
            roles/firebaserules.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:easee-deployer@$PROJECT.iam.gserviceaccount.com" \
    --role="$ROLE"
done
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
# for this command to work, the easee-api service must be deployed
pnpm dlx firebase-tools deploy --only hosting --project "$PROJECT"
```

#### The `/api/**` rewrite

Both sites rewrite `/api/**` to the `easee-api` Cloud Run service before the SPA catch-all, so the
frontends call their own origin and there is no CORS preflight on every request and no second
hostname to configure per environment. **The order in `firebase.json` matters**: a catch-all placed
first would swallow `/api/**` and hand the PWA an HTML page where it expected JSON — which fails at
runtime in production only, since the Vite dev server proxies `/api` itself.

That rewrite requires `easee-api` to allow unauthenticated invocations:

```bash
gcloud run services add-iam-policy-binding easee-api \
  --project="$PROJECT" --region="$REGION" \
  --member=allUsers --role=roles/run.invoker
```

**`allUsers` is not a shortcut here — it is the only binding that works.** Hosting proxies a rewrite
to Cloud Run *anonymously*: it attaches no identity token and acts under no service account, so there
is no principal to grant `roles/run.invoker` to instead. There is no
`service-$PROJECT_NUMBER@gcp-sa-firebasehosting.iam.gserviceaccount.com` agent — Firebase Hosting is
not a service-agent-based producer, and `services identity create` rejects it with `Invalid service
producer`. Granting anything narrower leaves the rewrite returning a Google-generated `403 Forbidden`
HTML page, which the PWA sees as malformed JSON.

The consequence is that the raw `*.run.app` URL is publicly reachable, not just the Hosting origin.
That is tolerable only because **`easee-api` authenticates every request itself** and never relies on
Cloud Run IAM as a gate: `requireAuth` verifies Easee/Keycloak RS256 JWTs against cached JWKS
(`services/api/src/middleware/easeeAuth.ts`) and maps the caller to their own parking lots
(`middleware/authorize.ts`), while `/api/admin/**` sits behind `adminBasicAuth`, a Secret
Manager–backed credential that fails closed when unset. Only `GET /api/health` and the two
`/api/auth/{login,refresh}` endpoints are deliberately open. Any new route must bring its own
middleware — the network is not a boundary for this service.

#### Custom domains (optional)

Free managed HTTPS, which is the whole reason for the deviation:

```bash
pnpm dlx firebase-tools hosting:sites:list --project "$PROJECT"
# then add the domain in the console or with `firebase hosting:channel`, and follow the DNS records
# it gives you. Certificates are issued and renewed automatically.
```

### 9. After the first deploy

Everything above can be done on an empty project. The two Cloud Run services do not exist yet, so
anything that *names* one of them has to wait until after the images are in Artifact Registry and the
service YAMLs have been applied once.

Normally that first deploy is a merge to `main`:
[`deploy.yml`](../.github/workflows/deploy.yml) builds both images, pushes them to
`europe-west6-docker.pkg.dev/$PROJECT/services`, and applies the two service YAMLs. But step 7 is
what makes CI able to do that, so on a fresh project it is usually faster to bootstrap by hand —
these are the same commands the workflow runs, so nothing here diverges from what CI does later.

**Push the two images.** From the **repository root**, not `infra/` — both Dockerfiles copy the
workspace manifests and the lockfile, so the build context has to be the root:

```bash
PROJECT=solarpowerconsumptionoptimizer
REGION=europe-west6
REGISTRY="$REGION-docker.pkg.dev/$PROJECT/services"

# One-time per machine: makes docker push use the gcloud credentials.
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet

for SERVICE in api optimizer; do
  IMAGE="$REGISTRY/easee-${SERVICE}:$(git rev-parse HEAD)"
  docker build -f "services/${SERVICE}/Dockerfile" -t "$IMAGE" .
  docker tag "$IMAGE" "$REGISTRY/easee-${SERVICE}:latest"
  docker push "$IMAGE"
  docker push "$REGISTRY/easee-${SERVICE}:latest"
done
```

Keep the braces on `${SERVICE}`. In zsh an unbraced `$SERVICE:latest` is parsed as the parameter
`SERVICE` with the `:l` (lowercase) modifier followed by the literal `atest`, so the tag silently
becomes `easee-apiatest:latest` — the push succeeds, and the later `replace` fails with
`Image ... easee-api:latest not found`.

Both tags are pushed on purpose. The commit tag is the immutable record of what a revision contains;
`:latest` is what the service YAMLs pin, so it is the one a `replace` resolves. On an Apple Silicon
machine add `--platform linux/amd64` to the build — Cloud Run runs amd64, and an arm64 image is
accepted by the registry and only fails at container start.

**Create the services** (from `infra/`):

```bash
for SERVICE in api optimizer; do
  gcloud run services replace "cloudrun/$SERVICE.service.yaml" \
    --project="$PROJECT" --region="$REGION"
done
```

`replace` is the same verb CI uses, and it both creates and updates: the YAML in the repository is
the whole definition, so there is nothing to drift (constitution, Technology & Deployment
Constraints).

**Then the bindings and jobs that needed a service to exist:**

```bash
# Deferred from step 4 — the scheduler is the optimizer's only permitted caller.
gcloud run services add-iam-policy-binding easee-optimizer \
  --project="$PROJECT" --region="$REGION" \
  --member="serviceAccount:easee-scheduler@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/run.invoker
```

Two earlier steps are also in this category and belong here on a first run, after the services
exist: [step 5](#5-the-cycle) (`optimizer-cycle.sh` starts with a `describe` of `easee-optimizer`)
and the `allUsers` binding in [the `/api/**` rewrite](#the-api-rewrite). The two differ in posture:
the optimizer is reachable only by the scheduler's OIDC identity, whereas the API is reachable by
anyone at its `*.run.app` URL and is guarded by its own auth middleware rather than by IAM — see
that section for why Hosting leaves no other option.

**Verify.** Four things, in the order they can fail:

```bash
gcloud run services list --project="$PROJECT" --region="$REGION"

API_URL="$(gcloud run services describe easee-api \
  --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
curl --fail --silent --show-error "$API_URL/api/health"; echo

gcloud scheduler jobs describe optimizer-cycle --project="$PROJECT" --location="$REGION"

# The first cycle, on demand rather than waiting up to five minutes for one.
gcloud scheduler jobs run optimizer-cycle --project="$PROJECT" --location="$REGION"
gcloud logging read \
  'resource.labels.service_name="easee-optimizer" severity>=WARNING' \
  --project="$PROJECT" --limit=20 --freshness=10m
```

A cycle that runs before `parkingLots` is seeded is expected to decide nothing — that is the
starting point for the rollout below, not a failure.

## Rollout to the hardware

The only real hardware is the owner's own parking lot. The sequence, from
[`quickstart.md`](../specs/001-solar-charging-mvp/quickstart.md):

1. `pnpm cycle:dry-run --lot=<owner-lot>` — computes the decision and writes nothing.
2. Seed `parkingLots` with the owner's lot **only**, and let the cycle run for a full session.
3. Watch `GET /api/admin/chargers/<lot>/trace`.
4. Only then widen the mapping to the other 29 lots.
