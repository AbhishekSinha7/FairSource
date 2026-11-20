// API reference, rendered with Scalar from the OpenAPI spec in @fairsource/shared.
// Public (no sign-in) and self-contained: the spec is embedded, so it works even
// when the API isn't running. Opened in a new tab from the dashboard.

import { openApiSpec } from '@fairsource/shared';
import { publicUrls } from '@/lib/config';

export const dynamic = 'force-static';

const SCALAR = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.4';
const FONTS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+Devanagari:wght@400;500;600&display=swap';

// FairSource colours on Scalar's theme variables (light and dark).
const CSS = `
.light-mode {
  --scalar-color-accent: #3b45cc;
  --scalar-background-1: #ffffff;
  --scalar-background-2: #f6f5f1;
  --scalar-background-3: #ecebe6;
  --scalar-background-accent: #eceefc;
  --scalar-color-1: #17181c;
  --scalar-color-2: #4a4a50;
  --scalar-color-3: #6b6b70;
  --scalar-border-color: #e7e5df;
  --scalar-color-green: #1d7a46;
  --scalar-color-red: #b42318;
  --scalar-color-orange: #8a5a00;
}
.dark-mode {
  --scalar-color-accent: #8087e0;
  --scalar-background-1: #18191d;
  --scalar-background-2: #1f2025;
  --scalar-background-3: #2a2c33;
  --scalar-background-accent: #2a2d55;
  --scalar-color-1: #f3f2ee;
  --scalar-color-2: #c9c9cf;
  --scalar-color-3: #a3a4ab;
  --scalar-border-color: #2f3138;
}
:root {
  --scalar-font: 'Inter', 'Noto Sans Devanagari', system-ui, sans-serif;
  --scalar-font-code: 'JetBrains Mono', ui-monospace, monospace;
  --scalar-radius: 8px;
  --scalar-radius-lg: 12px;
}
`;

export function GET() {
  const spec = openApiSpec(publicUrls());
  // Safe to embed in a <script>: no "</script>" can survive the escaping.
  const json = JSON.stringify(spec).replace(/</g, '\\u003c');
  const config = JSON.stringify({
    theme: 'none',
    customCss: CSS,
    withDefaultFonts: false,
    defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
    authentication: { preferredSecurityScheme: 'apiKey' },
    metaData: { title: 'FairSource API', description: 'Licensed, attributed content for AI.' },
    documentDownloadType: 'json',
    persistAuth: false,
    showDeveloperTools: 'never', // Scalar's own toolbar (shown on localhost by default)
    agent: { disabled: true }, // "Ask AI" sends questions to Scalar's service
  }).replace(/</g, '\\u003c');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FairSource API reference</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="${FONTS}" />
    <style>body { margin: 0; background: #ffffff; }</style>
  </head>
  <body>
    <div id="app"></div>
    <noscript>The API reference needs JavaScript. The raw OpenAPI document is at <a href="/openapi.json">/openapi.json</a>.</noscript>
    <script src="${SCALAR}"></script>
    <script>
      Scalar.createApiReference('#app', Object.assign(${config}, { content: ${json} }));
    </script>
  </body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
