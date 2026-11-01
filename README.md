# Workspace integration service

Backend for the sidebar of the 3D sales workspace. It combines a **sizing tool**, **catalogue** and **pricing ERP** (all mocked), handles their limits and outages, and hides prices from roles that may not see them.

Two services:

- **API** on port 3000: sidebar, BOM, re-size, live updates (SSE), chat
- **MCP service** on port 3001: AI tools for external AI apps; it calls the API as the user

## Run

**Node.js 20+**

```bash
npm install
npm start            # API
npm run start:mcp    # MCP service (second terminal)
npm test             # 79 tests
```

**Docker**

```bash
cp .env.example .env     # then set API_URL=http://api:3000
docker compose up --build
```

## Try it

Import `postman/workspace-integration.postman_collection.json` into Postman and run the requests in order. Tokens are created automatically.

The sizing mock is slow and fails 20% of requests on purpose, so sizing may show `pending` or `unavailable`; send it again.

## Endpoints

| API (:3000) | |
|---|---|
| `GET /projects/:id` | Project items |
| `GET /projects/:id/items/:itemId/sidebar` | Sidebar for one item |
| `POST /projects/:id/items/:itemId/resize` | Re-size a drive |
| `GET /projects/:id/bom` | Parts list with prices |
| `GET /catalogue/search` | Search products |
| `GET /projects/:id/events` | Live updates |
| `POST /projects/:id/assistant/messages` | AI chat |
| `POST /projects/:id/assistant/proposals/:pid/confirm` | Confirm an AI-proposed change |

| MCP service (:3001) | |
|---|---|
| `POST /mcp` | AI tools: `get_project_layout`, `get_item_details`, `get_bom_cost`, `search_catalogue`, `resize_item` |

All routes except `/health` need `Authorization: Bearer <token>` (`npm run -s token -- --role sales_engineer`).

## Notes

- **Roles:** channel partners never receive prices or lead times; users only see their own projects.
- **Chat** needs a local model: install [Ollama](https://ollama.com) and run `ollama pull qwen2.5:3b`. In Docker, also set `LLM_BASE_URL=http://host.docker.internal:11434/v1` in `.env`. Without it, chat answers `503`.
- **Simplified for local use:** data is in memory and tokens are signed locally; production uses PostgreSQL, Redis and the customer's identity provider.
