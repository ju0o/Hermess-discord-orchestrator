# Free Model Pool

The QwenCloud Workspace Free Tier pool is a provider-scoped registry. It is
separate from the Worker CLI catalog because the same provider resource can be
used by ASUS PM routing without pretending that it belongs to one Worker.

`FREE_TIER_CANDIDATES` contains every candidate supplied by the owner. Registry
registration is idempotent and retains the existing health state. Candidate
metadata records the route class and capabilities; special-purpose models may
be active for their capability without entering general PM routing.

## Health states

`UNKNOWN` and `PROBING` are not routable. Only `AVAILABLE` enters an active
capability pool. `AUTH_FAILED`, `QUOTA_EXHAUSTED`, `RATE_LIMITED`,
`TEMP_UNAVAILABLE`, and `UNAVAILABLE` remain model/provider evidence and are
not silently converted into another credential or PAYG route.

The `models:probe` command uses the existing Hermes secure credential pool and
performs one bounded `GET /models` catalog/auth probe. It does not print keys,
does not make 75 inference calls, and does not retry indefinitely. A provider
authentication failure is recorded for the provider's candidates; a catalog
miss is recorded only for that model.

```text
npm run models:probe
```

The probe result is intentionally not an execution verification. A listed
model is catalog/auth available; an inference can still fail later and must be
recorded as model-scoped evidence.

