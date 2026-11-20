// The raw OpenAPI document, for importing into Postman, code generators or agents.

import { openApiSpec } from '@fairsource/shared';

export const dynamic = 'force-static';

export function GET() {
  const domain = process.env.NEXT_PUBLIC_FAIRSOURCE_DOMAIN;
  return Response.json(openApiSpec({ apiBaseUrl: domain ? `https://api.${domain}` : undefined }));
}
