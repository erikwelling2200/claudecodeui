// chatToolsService: used by the websocket module to append the configured text
// to prompts, and by the server entrypoint to register the MCP server at startup.
export { chatToolsService } from './chat-tools.service.js';
// chatToolsRoutes: mounted by the server entrypoint at `/api/chat-tools` (JWT protected).
export { chatToolsRoutes } from './chat-tools.routes.js';
// chatToolsMcpRoutes: mounted by the server entrypoint at `/api/chat-tools-mcp` (MCP token protected).
export { chatToolsMcpRoutes } from './chat-tools-mcp.routes.js';
