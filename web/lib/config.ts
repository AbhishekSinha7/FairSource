// The public addresses shown in copy-paste snippets (Playground curl, MCP config, docs).
// NEXT_PUBLIC_FAIRSOURCE_URL: one address for everything (Firebase Hosting), e.g. https://ask123.web.app
// NEXT_PUBLIC_FAIRSOURCE_DOMAIN: older layout with api.<domain> and mcp.<domain>.
const PUBLIC_URL = process.env.NEXT_PUBLIC_FAIRSOURCE_URL?.replace(/\/$/, '');
export const DOMAIN = process.env.NEXT_PUBLIC_FAIRSOURCE_DOMAIN ?? '[YOUR DOMAIN]';
export const API_BASE = PUBLIC_URL ?? `https://api.${DOMAIN}`;
export const MCP_URL = PUBLIC_URL ? `${PUBLIC_URL}/mcp` : `https://mcp.${DOMAIN}/mcp`;

/** For the API reference: the base URL and MCP URL, when one is configured. */
export function publicUrls(): { apiBaseUrl?: string; mcpUrl?: string } {
  if (PUBLIC_URL) return { apiBaseUrl: PUBLIC_URL, mcpUrl: `${PUBLIC_URL}/mcp` };
  const d = process.env.NEXT_PUBLIC_FAIRSOURCE_DOMAIN;
  return d ? { apiBaseUrl: `https://api.${d}`, mcpUrl: `https://mcp.${d}/mcp` } : {};
}
