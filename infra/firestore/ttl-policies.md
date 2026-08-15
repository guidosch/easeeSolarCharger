# Firestore TTL policies

Retention is enforced by the database, not by a cleanup job that might not run (Principle VI,
FR-047). Every collection that grows carries an `expiresAt` **Timestamp** field, and a TTL policy
on that field deletes the document one month after it was written.

TTL policies are not expressible in `firestore.indexes.json`, so they are applied once with
`gcloud`. This file is the record of what must exist; `infra/README.md` links to it from the
one-time setup checklist.

```bash
PROJECT=easee-solar-charger

for COLLECTION in cycles chargerSnapshots chargerEvents; do
  gcloud firestore fields ttls update expiresAt \
    --collection-group="$COLLECTION" \
    --enable-ttl \
    --project="$PROJECT"
done

# Verify — each should report state ACTIVE.
gcloud firestore fields ttls list --project="$PROJECT"
```

## Which collections do *not* have a TTL, and why

| Collection | Retention | Enforced by |
| --- | --- | --- |
| `users/{userId}/sessions` | five most recent | `SessionsRepo.close` deletes the surplus in the same batch (FR-038) |
| `users/{userId}/targets` | until closed with their session | deleted with the user tree on `DELETE /me` (FR-048) |
| `parkingLots`, `chargers` | forever | operator data and a fixed-size live mirror; neither grows |
| `fairness` | until the user deletes | removed by `DELETE /me` |
| `locks`, `providerTokens` | single documents, overwritten in place | — |

A TTL policy deletes within 24 hours of the expiry timestamp rather than at it. That is inside the
"older than one month" wording of FR-047, but it means a test asserting deletion must assert on
`expiresAt` being set and in the past, not on the document already being gone — which is what
`services/api/tests/retention.test.ts` does.
