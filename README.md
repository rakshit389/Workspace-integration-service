# Workspace integration service

The backend for the sidebar of the 3D sales workspace. For a selected item, it collects data from three enterprise systems (**sizing tool**, **product catalogue**, **pricing ERP**), handles their limits and outages, and hides prices from users who may not see them.

The three systems are mocked and start automatically, so nothing else is needed.

## Quick start

**Option 1: Node.js 20 or later**

```bash
npm install
npm start
```

**Option 2: Docker**

```bash
cp .env.example .env
docker build -t workspace-integration-service .
docker run --rm -p 3000:3000 --env-file .env workspace-integration-service
```

The API is now on `http://localhost:3000`.

**Run the tests:** `npm test` (77 tests, about 3 seconds).

## Try it

**Easiest: Postman.** Import `postman/workspace-integration.postman_collection.json` and run the requests from top to bottom. Login tokens are created automatically.

**Or with curl**, in a second terminal:

```bash
TOKEN=$(npm run -s token)
curl -H "Authorization: Bearer $TOKEN" localhost:3000/projects/P-24117/bom
```

Use `npm run -s token -- --role channel_partner` for a channel partner, or `--role admin` for an administrator.

The demo data (`data/projects.json`) has project **P-24117** with two drives, two cabinets and a panel.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/projects/:projectId` | Lists the items in a project |
| GET | `/projects/:projectId/items/:itemId/sidebar` | Sidebar for one item (catalogue, sizing, price) |
| GET | `/projects/:projectId/items/:itemId/panels/:panelId` | One sidebar panel only, for a retry |
| POST | `/projects/:projectId/items/:itemId/resize` | Re-sizes a drive, e.g. `{ "motorKw": 110 }` |
| GET | `/projects/:projectId/bom` | Parts list with prices |
| GET | `/catalogue/search` | Searches products, e.g. `?kind=drive&minKw=90` |
| GET | `/projects/:projectId/events` | Live updates (Server-Sent Events) |
| POST | `/projects/:projectId/events/ticket` | One-time ticket to open live updates from a browser |
| POST | `/mcp` | AI tools, for any MCP client |
| POST | `/projects/:projectId/assistant/messages` | Chat with the AI assistant |
| POST | `/projects/:projectId/assistant/proposals/:id/confirm` | Confirm a change the assistant proposed |
| POST | `/projects/:projectId/assistant/proposals/:id/cancel` | Reject it |
| GET | `/health` | Is the service up? (no login needed) |

All routes except `/health` need `Authorization: Bearer <token>`.

## Who sees what

| Role | Prices and lead times | Re-size | Projects |
|---|---|---|---|
| Sales engineer | ✅ in their country's currency | ✅ | Their own |
| Channel partner | ❌ never sent | ❌ | Their own |
| Administrator | ✅ | ✅ | All |

Role and country come only from the token. Projects you are not a member of answer `404`.

## Sidebar panel status

Each panel reports its own status, so one slow or failing system never blanks the whole sidebar.

| Status | Meaning |
|---|---|
| `ok` | Fresh data |
| `stale` | Older data, because the system is failing |
| `pending` | Still loading; the result is pushed over live updates when ready |
| `unavailable` | No data; the message says why |
| `not_permitted` | This role may not see it |

## Slow and failing systems

| System | Cache | Protection |
|---|---|---|
| Catalogue | 10 minutes | Shows older data if it fails |
| Sizing tool (slow, often fails) | 24 hours | Retries, and a **circuit breaker** that stops calling it after 5 failures in a row |
| Pricing ERP (5 requests/second) | 24 hours | **Rate limiter** that never sends more than 5 calls per second |

If a system changes its response format, that panel shows `unavailable` with a clear message instead of wrong data. Settings are in `src/config.ts`.

## AI assistant

The assistant has five tools. They run **as the user**, so the AI can never see more than the user can.

| Tool | Does |
|---|---|
| `get_project_layout` | Lists the project's items |
| `get_item_details` | Details of one item |
| `get_bom_cost` | Total cost and longest lead time |
| `search_catalogue` | Finds products |
| `resize_item` | **Proposes** a re-size; the user must confirm it |

**Two ways to use the tools:**

- **External AI apps** (for example MCP Inspector or Claude Desktop) connect to `/mcp` with a user's token.
- **Our chat** (`/assistant/messages`) uses a language model to answer questions with these tools.

**Chat needs a local language model** (free, runs on your machine):

```bash
brew install ollama
brew services start ollama
ollama pull qwen2.5:3b
```

Without it, chat answers `503`; everything else still works. The tests use a fake model.

## Docker

The image contains the API and the three mocked systems. Only port 3000 needs publishing.

- **Settings** go in `.env` (copied from `.env.example`). Empty values use the defaults. `.env` is not committed and not copied into the image.
- **For chat in Docker**, add this to `.env`, so the container can reach Ollama on your machine:

  ```
  LLM_BASE_URL=http://host.docker.internal:11434/v1
  ```

- **Run in the background:** add `-d --name wis` to `docker run`. See logs with `docker logs -f wis`, stop with `docker stop wis`.
- **Rebuild** the image after changing code. Each run starts from the demo data again.

## How the code is organised

Every request goes through four layers:

| Layer | Folder | Does |
|---|---|---|
| 1. Authentication | `src/auth/tokens.ts` | Checks the login token |
| 2. Authorization | `src/auth/policy.ts` | Decides what the user may see and do |
| 3. Orchestration | `src/orchestration/` | Combines systems into features (sidebar, BOM, re-size) |
| 4. Adapters | `src/adapters/` | Talks to one system each, with cache, retries and limits |

Other folders: `src/panels/` (sidebar panels), `src/assistant/` (AI tools and chat), `src/events/` (live updates), `src/mocks/` (fake enterprise systems).

**Adding a new system:** add one file to `src/panels/`, for example `documents.panel.ts`. It is picked up automatically; nothing else changes.

## Tests

`npm test` covers:

- a system failing, slow or changing its format: the other panels still work
- prices hidden from channel partners, including in AI answers
- re-size: new drive, new 3D model and BOM change
- caching, retries, circuit breaker and rate limit
- live updates, catalogue search, AI tools and chat

## What is simplified

| Here | In production |
|---|---|
| Data kept in memory | PostgreSQL and Redis |
| Tokens signed locally (`npm run token`) | The customer's identity provider |
| Mocked enterprise systems | The real systems |
| Local model through Ollama | The customer's private Azure OpenAI |
