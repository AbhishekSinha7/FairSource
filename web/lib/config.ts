/** Public domain for the API and MCP server, shown in copy-paste snippets. */
export const DOMAIN = process.env.NEXT_PUBLIC_FAIRSOURCE_DOMAIN ?? '[YOUR DOMAIN]';
export const API_BASE = `https://api.${DOMAIN}`;
export const MCP_URL = `https://mcp.${DOMAIN}/mcp`;
