import { defaultConfig } from './config.js';
import { buildMcpApp } from './mcp/app.js';

const config = defaultConfig();
const app = await buildMcpApp({ config, logger: true });
await app.listen({ host: '0.0.0.0', port: config.mcp.port });

console.log(`
MCP service on http://localhost:${config.mcp.port}/mcp
Calls the workspace API at ${config.mcp.apiUrl} with each user's token.
`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
