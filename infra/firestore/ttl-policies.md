# Firestore TTL policies

Retention is enforced by the database, not by a cleanup job that might not run (Principle VI,
FR-047). Every collection that grows carries an `expiresAt` **Timestamp** field, and a TTL policy
on that field deletes the document one month after it was written.

The policies are declared in `firestore.indexes.json` as `fieldOverrides` with `"ttl": true`, so
`firebase deploy --only firestore:indexes` applies them and no manual step is needed. They must be
declared there even though they already exist in the project: the deploy compares the file against
every field override the project has, and an override it cannot find in the file is drift it
refuses to ignore — in `--non-interactive` mode that is a hard `Pass the --force flag` failure, and
with `--force` it would *delete* the TTL policies and silently end retention.

`"indexes": []` next to the TTL exempts `expiresAt` from single-field indexing. Nothing queries the
field, and its values are near-monotonic, which is exactly the shape that hotspots an index — so
the exemption saves three index writes per document and is what Firestore recommends for TTL
fields.

```bash
# Verify — each of the three should report state ACTIVE.
gcloud firestore fields ttls list --project=solarpowerconsumptionoptimizer
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
