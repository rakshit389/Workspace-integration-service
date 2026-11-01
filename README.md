# Workspace integration service

The backend that feeds the tool sidebar of the 3D sales workspace. It aggregates a **sizing tool**, a **product catalogue** and a **pricing ERP** for one placed item, respects each system's limits and outages, and enforces price visibility on the server.

All three enterprise systems are mocked and start with the service, so nothing else needs to be installed.

## Run it

Requires **Node.js 20 or later**.

```bash
npm install
npm start        # API on :3000, mocks on :4001-4003
npm test         # 36 tests, about 3 seconds
```

## Try it

In a second terminal, from this folder:

```bash
SE=$(npm run -s token -- --role sales_engineer --country DE)
CP=$(npm run -s token -- --role channel_partner --country DE)
DRV03=3f6c1d2e-0a41-4b8e-9d1e-2b7c1f0a9e03

# Sidebar for DRV-03. The sizing mock takes 0.5–3 s, so the first call usually returns
# sizing as "pending" within the budget; call again a few seconds later and it is "ok".
curl -s -H "Authorization: Bearer $SE" localhost:3000/projects/P-24117/items/$DRV03/sidebar

# The same sidebar for a channel partner: pricing is "not_permitted".
curl -s -H "Authorization: Bearer $CP" localhost:3000/projects/P-24117/items/$DRV03/sidebar

# Project BOM: with prices and totals for the sales engineer, without any price fields for the partner.
curl -s -H "Authorization: Bearer $SE" localhost:3000/projects/P-24117/bom
curl -s -H "Authorization: Bearer $CP" localhost:3000/projects/P-24117/bom

# Re-size DRV-03 for a 110 kW motor: R7 → R8, new 3D model, BOM change and price difference.
curl -s -X POST -H "Authorization: Bearer $SE" -H 'content-type: application/json' \
  -H 'idempotency-key: demo-1' -d '{"motorKw":110,"baseRevision":1}' \
  localhost:3000/projects/P-24117/items/$DRV03/resize
```

`GET /projects/P-24117` lists every item with its ID. The seed project (`data/projects.json`) holds two drives, two cabinets and a panel.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects/:projectId` | Items in the project |
| GET | `/projects/:projectId/items/:itemId/sidebar` | All panels for one item, within a 600 ms budget |
| GET | `/projects/:projectId/items/:itemId/panels/:panelId` | One panel, for retry or refresh |
| POST | `/projects/:projectId/items/:itemId/resize` | Body `{ motorKw, voltage?, baseRevision? }`; optional `Idempotency-Key` header |
| GET | `/projects/:projectId/bom` | Project BOM, prices filtered by role |
| GET | `/health` | Liveness, no token needed |

Every other route needs `Authorization: Bearer <token>`. The token's `role` and `country` claims are the only source of role and country.

### Panel status

| Status | Meaning |
|---|---|
| `ok` | Fresh data |
| `stale` | Last good value, with `asOf` and a reason, because the system is failing or slow |
| `pending` | Still running after the budget; the result is cached when it lands, so call again after `retryAfterMs` |
| `unavailable` | No data and no fallback; `message` says why |
| `not_permitted` | The user's role may not see this panel; the system was not called |

## How the code is organised

Requests pass through four layers, the same as in the design document:

| Layer | Folder | Does |
|---|---|---|
| 1. Authentication | `src/auth/tokens.ts` | Verifies signature, issuer, audience and expiry; builds the user from claims |
| 2. Authorization | `src/auth/policy.ts`, `isPermitted` in each panel | One set of rules, deny by default; a denied system is never called |
| 3. Orchestration | `src/orchestration/` | Sidebar fan-out, BOM, re-size, idempotency |
| 4. Adapters | `src/adapters/` | One per system: cache, retries, breaker or rate limit, mapping |

Shared resilience parts are in `src/resilience/`, the mocks in `src/mocks/`, and the in-memory project store in `src/store/`.

## Limits and failures, per system

| System | Cache TTL | Retries | Protection |
|---|---|---|---|
| Catalogue | 10 min | 2, backoff from 100 ms | Stale value for up to 24 h if it fails |
| Sizing tool | 24 h, keyed by inputs and country | 2, backoff from 200 ms | **Circuit breaker**: opens after 5 consecutive failures, retries after 30 s |
| Pricing ERP | 24 h, capped at the quote's `validUntil` | 2, honours `Retry-After` | **Rate limiter**: never more than 5 calls in any second |

All values are in `src/config.ts`. Concurrent requests for the same key share one call to the system (single flight), and a call that outlives the budget keeps running and fills the cache.

## Adding a fourth system

Add one file to `src/panels/`, for example `documents.panel.ts`, that default-exports a `PanelDefinition` (`id`, `order`, `appliesTo`, `isPermitted`, `load`). The registry discovers `*.panel.ts` files at start-up and the sidebar includes the new panel. No other file changes.

## Tests

| Brief requirement | Covered in |
|---|---|
| Partial results when a system fails | `test/sidebar.test.ts`: sizing down, slow (`pending`), expired cache (`stale`), circuit breaker, retry |
| Entitlement filtering | `test/entitlements.test.ts`: partner gets no prices and the ERP is not called; currency follows the token; invalid, expired and wrong-audience tokens rejected |
| Re-size flow | `test/resize.test.ts`: variant and 3D model change, BOM change, no-change case, revision conflict, sizing failure, idempotency |
| Cache, retry, breaker, rate limit | `test/resilience.test.ts` |

## Simplifications

- **Storage:** projects live in memory (`InMemoryProjectRepository`) and caches are in-process. Production uses PostgreSQL and Redis behind the same interfaces, so limits and breaker state are shared across replicas.
- **Identity:** tokens are signed locally with HS256 by `npm run token`. Production verifies the customer's OIDC tokens against its JWKS.
- **Delegated token:** the sizing adapter forwards the user's token; production exchanges it on-behalf-of for a sizing-scoped token.
- **Catalogue:** read from the mock per variant and cached. Production serves it from a read model synced from the nightly export and change feed.
- **Slow results:** `pending` panels are re-polled. Production pushes them to the browser over SSE.

## Docker and CI

```bash
docker build -t workspace-integration-service .
docker run -p 3000:3000 workspace-integration-service
```

`.github/workflows/ci.yml` type-checks, tests and builds on Node 20 and 22, then builds the image.

## AI tools used

Built with **Claude Code** (Anthropic) in VS Code. I used it to:

- talk through the brief and the architecture, and challenge each decision (for example BFF versus microservices, SSE versus WebSockets, PostgreSQL versus MongoDB);
- draft the design document and the architecture diagram;
- generate this service layer by layer from the agreed design, then run the type check, the tests and a manual curl walkthrough against the mocks.

I reviewed the design decisions and the code, and can explain or change any part of it.
