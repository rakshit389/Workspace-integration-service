# Workspace integration service

The backend that feeds the tool sidebar of the 3D sales workspace. It aggregates a **sizing tool**, a **product catalogue** and a **pricing ERP** for one placed item, respects each system's limits and outages, and enforces price visibility on the server.

All three enterprise systems are mocked and start with the service, so nothing else needs to be installed.

## Run it

**With Node.js 20 or later:**

```bash
npm install
npm start        # API on :3000, mocks on :4001-4003
npm test         # 77 tests, about 3 seconds; no language model needed
```

**Or with Docker** (no Node.js needed):

```bash
cp .env.example .env
docker build -t workspace-integration-service .
docker run --rm -p 3000:3000 --env-file .env workspace-integration-service
```

Both start the API on `http://localhost:3000` with the three mocked systems. See [Docker](#docker) for details.

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

**Postman:** import `postman/workspace-integration.postman_collection.json`. It has every endpoint in seven folders (sales engineer, channel partner, re-size, AI assistant, access checks, administrator, server push), and each folder signs its own local token, so nothing needs copying.

`GET /projects/P-24117` lists every item with its ID. The seed project (`data/projects.json`) holds two drives, two cabinets and a panel, and its members are the default users from `npm run token`. A second project, `P-30002`, belongs to another user, so it answers `404` for them; `--role admin` opens both.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects/:projectId` | Items in the project |
| GET | `/projects/:projectId/items/:itemId/sidebar` | All panels for one item, within a 600 ms budget |
| GET | `/projects/:projectId/items/:itemId/panels/:panelId` | One panel, for retry or refresh |
| POST | `/projects/:projectId/items/:itemId/resize` | Body `{ motorKw, voltage?, baseRevision? }`; optional `Idempotency-Key` header |
| GET | `/projects/:projectId/bom` | Project BOM, prices filtered by role |
| GET | `/catalogue/search` | Search variants: `q`, `kind`, `minKw`, `maxKw`, `ipRating`, `limit` |
| GET | `/projects/:projectId/events` | Server-Sent Events stream for the project |
| POST | `/projects/:projectId/events/ticket` | One-time ticket for opening the stream from a browser |
| POST | `/mcp` | MCP server with the assistant's tools |
| POST | `/projects/:projectId/assistant/messages` | Chat: a question in, the assistant's answer out (needs a language model) |
| POST | `/projects/:projectId/assistant/proposals/:proposalId/confirm` | The user confirms a change the assistant proposed |
| POST | `/projects/:projectId/assistant/proposals/:proposalId/cancel` | The user rejects it |
| GET | `/health` | Liveness, no token needed |

Every other route needs `Authorization: Bearer <token>`. The token's `role` and `country` claims are the only source of role and country. A user only reaches projects they are a member of (administrators reach all); any other project answers `404`, so its existence is not revealed.

### Panel status

| Status | Meaning |
|---|---|
| `ok` | Fresh data |
| `stale` | Last good value, with `asOf` and a reason, because the system is failing or slow |
| `pending` | Still running after the budget; the result is pushed over SSE when it lands (or call again after `retryAfterMs`) |
| `unavailable` | No data and no fallback; `message` says why |
| `not_permitted` | The user's role may not see this panel; the system was not called |

## How the code is organised

Requests pass through four layers, the same as in the design document:

| Layer | Folder | Does |
|---|---|---|
| 1. Authentication | `src/auth/tokens.ts` | Verifies signature, issuer, audience and expiry; builds the user from claims |
| 2. Authorization | `src/auth/policy.ts`, `isPermitted` in each panel | One set of rules, deny by default: project membership, then per-panel rules; a denied system is never called |
| 3. Orchestration | `src/orchestration/` | Sidebar fan-out, BOM, re-size, idempotency |
| 4. Adapters | `src/adapters/` | One per system: response schema, cache, retries, breaker or rate limit |

Shared resilience parts are in `src/resilience/`, the AI tools in `src/assistant/`, server push in `src/events/`, the mocks in `src/mocks/`, and the in-memory project store in `src/store/`.

## Server push (SSE)

A sidebar panel that is still `pending` when the budget runs out keeps waiting in the background, joining the same in-flight call, so the system is not called twice. When it lands, the result is pushed to the user's stream as `panel.updated`. A re-size pushes `item.updated` to everyone viewing the project; that event carries no prices.

```bash
# Terminal A: listen
curl -N -H "Authorization: Bearer $SE" localhost:3000/projects/P-24117/events
# Terminal B: click the item; sizing comes back "pending", then arrives in terminal A
curl -s -H "Authorization: Bearer $SE" localhost:3000/projects/P-24117/items/$DRV03/sidebar
```

Browsers cannot send headers with `EventSource`, and a token in the URL would end up in logs, so a browser first calls `POST /projects/P-24117/events/ticket` and opens the returned URL. The ticket works once, for one project, for 60 seconds.

## AI assistant tools (MCP)

`POST /mcp` is a Model Context Protocol server (Streamable HTTP, stateless). The caller's token is checked like on every other route, and every tool runs **as that user** through the same authorization, orchestration and adapters as the sidebar, so the assistant cannot see a price or project the user cannot.

| Tool | Does |
|---|---|
| `get_project_layout` | Items in the project |
| `get_item_details` | Catalogue, sizing and (if permitted) price for one item, by tag or ID |
| `get_bom_cost` | BOM with totals and longest lead time; no prices for roles that may not see them |
| `search_catalogue` | Finds variants by text, kind, power and IP rating; no prices |
| `resize_item` | **Proposes** a re-size and returns a `proposalId`. It never changes the project. |

A proposal is applied only when the user's browser calls `POST …/assistant/proposals/:proposalId/confirm` with the user's own token. Proposals belong to one user, work once, expire after 10 minutes, and are refused if the item changed in the meantime. Every tool call and confirmation is recorded in the audit log (`src/assistant/audit.ts`).

Prompt injection: tool output is returned as data, the model has no tool that sends anything outside, and permissions never depend on the model behaving, so an injected instruction in catalogue text cannot reveal a price or apply a change.

```bash
curl -s localhost:3000/mcp -H "Authorization: Bearer $SE" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_bom_cost","arguments":{"projectId":"P-24117"}}}'
```

Any MCP client works, for example `npx @modelcontextprotocol/inspector` with the URL `http://localhost:3000/mcp` and an `Authorization: Bearer …` header.

## AI assistant chat

`POST /projects/:projectId/assistant/messages` takes `{ "message": "…", "history": [optional earlier turns] }`. The service sends the question and the five tool definitions to a language model, runs every tool the model asks for **as the user** (the same `src/assistant/tools.ts` the MCP server uses), passes the results back marked as data, and returns:

```json
{ "answer": "The layout costs 18952 EUR …", "toolCalls": [{ "name": "get_bom_cost", "isError": false }], "proposals": [] }
```

`proposals` lists any re-size the assistant proposed; the workspace shows it with a Confirm button that calls the confirm endpoint.

The model is any OpenAI-compatible endpoint, set with environment variables. The default is a small local model through Ollama, so no data leaves the machine, in line with the private-LLM requirement; production points the same settings at the private Azure OpenAI endpoint.

```bash
brew install ollama
brew services start ollama
ollama pull qwen2.5:3b
npm start
```

| Variable | Default |
|---|---|
| `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` (Ollama) |
| `LLM_MODEL` | `qwen2.5:3b` |
| `LLM_API_KEY` | not set (Ollama needs none) |

Without a reachable model, this endpoint answers `503 assistant_unavailable` and everything else keeps working. The tests use a scripted fake model and never need one. A small local model can pick the wrong tool or phrase an answer clumsily; it cannot see more than the user, because permissions are enforced in the tools, not by the model.

## Limits and failures, per system

| System | Cache TTL | Retries | Protection |
|---|---|---|---|
| Catalogue | 10 min | 2, backoff from 100 ms | Stale value for up to 24 h if it fails |
| Sizing tool | 24 h, keyed by inputs and country | 2, backoff from 200 ms | **Circuit breaker**: opens after 5 consecutive failures, retries after 30 s |
| Pricing ERP | 24 h, capped at the quote's `validUntil` | 2, honours `Retry-After` | **Rate limiter**: never more than 5 calls in any second |

All values are in `src/config.ts`. Concurrent requests for the same key share one call to the system (single flight), and a call that outlives the budget keeps running and fills the cache.

Every response is checked against a schema next to its adapter (zod). If a vendor changes its format, the call fails with a clear message such as `Sizing tool returned an unexpected response (frame: Required)`; it is not retried, and only that panel shows `unavailable`. Supporting a new response format means changing that one schema and mapping.

## Adding a fourth system

Add one file to `src/panels/`, for example `documents.panel.ts`, that default-exports a `PanelDefinition` (`id`, `order`, `appliesTo`, `isPermitted`, `load`). The registry discovers `*.panel.ts` files at start-up and the sidebar includes the new panel. No other file changes.

## Tests

| Brief requirement | Covered in |
|---|---|
| Partial results when a system fails | `test/sidebar.test.ts`: sizing down, slow (`pending`), expired cache (`stale`), circuit breaker, retry, changed response format |
| Entitlement filtering | `test/entitlements.test.ts`: partner gets no prices and the ERP is not called; currency follows the token; non-members get `404`; invalid, expired and wrong-audience tokens rejected |
| Re-size flow | `test/resize.test.ts`: variant and 3D model change, BOM change, no-change case, revision conflict, sizing failure, idempotency |
| Cache, retry, breaker, rate limit | `test/resilience.test.ts` |
| Server push | `test/events.test.ts`: slow sizing pushed when ready, per-user delivery, `item.updated` without prices, ticket, access |
| Catalogue search | `test/catalogue.test.ts`: filters, one export load for many searches, last read model kept when a refresh fails |
| Assistant chat | `test/chat.test.ts`: tools run as the user, a partner's model never receives prices, proposals need confirmation, other projects unreachable, tool output marked as data, round limit, model down |
| AI tools | `test/mcp.test.ts`: entitlements through the tools, proposal needs the user's confirmation, single use, expiry, conflicts |

## Simplifications

- **Storage:** projects live in memory (`InMemoryProjectRepository`) and caches are in-process. Production uses PostgreSQL and Redis behind the same interfaces, so limits and breaker state are shared across replicas.
- **Identity:** tokens are signed locally with HS256 by `npm run token`. Production verifies the customer's OIDC tokens against its JWKS.
- **Delegated token:** the sizing adapter forwards the user's token; production exchanges it on-behalf-of for a sizing-scoped token.
- **Catalogue:** single variants are read from the mock and cached; search runs on an in-memory read model loaded from the mock's bulk export (`GET /export`) and refreshed every 10 minutes, so searches never call the catalogue. Production keeps the read model in PostgreSQL, fed by the nightly export and the change feed, with full-text search.
- **Events and proposals:** the event hub, stream tickets, proposals and audit log are in memory. Production uses Redis pub/sub (so any replica can reach a user's stream), Redis for proposals and tickets, and PostgreSQL for the audit log.

## Docker

One image runs the whole service: the API and the three mocked systems, which talk to each other inside the container. Only port 3000 needs publishing.

```bash
cp .env.example .env                              # once; edit if needed
docker build -t workspace-integration-service .   # again after any code change
docker run --rm -p 3000:3000 --env-file .env workspace-integration-service
```

Stop it with `Ctrl + C`. `--rm` removes the container on exit, so the next run starts from the seed data again (re-sizes are not kept).

To run it in the background:

```bash
docker run -d --rm --name wis -p 3000:3000 --env-file .env workspace-integration-service
docker logs -f wis      # follow the logs
docker stop wis         # stop
```

**Settings** come from `.env` (see `.env.example`). Empty values use the defaults, and `.env` is kept out of both Git and the image. For the assistant chat, the container must reach a language model:

```bash
# .env — Ollama running on the machine that runs Docker
LLM_BASE_URL=http://host.docker.internal:11434/v1
```

Inside a container, `127.0.0.1` is the container itself; `host.docker.internal` is the machine running Docker. Without a reachable model, chat answers `503` and everything else works.

If port 3000 is taken (for example by `npm start`), stop that first or publish another port: `-p 3001:3000`, then call `http://localhost:3001`.

## CI

`.github/workflows/ci.yml` type-checks, tests and builds on Node 20 and 22, then builds the Docker image.

## AI tools used

Built with **Claude Code** (Anthropic) in VS Code. I used it to:

- talk through the brief and the architecture, and challenge each decision (for example BFF versus microservices, SSE versus WebSockets, PostgreSQL versus MongoDB);
- draft the design document and the architecture diagram;
- generate this service layer by layer from the agreed design, then run the type check, the tests and a manual curl walkthrough against the mocks.

I reviewed the design decisions and the code, and can explain or change any part of it.
