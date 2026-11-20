// The raw OpenAPI document, for importing into Postman, code generators or agents.

import { openApiSpec } from '@fairsource/shared';
import { publicUrls } from '@/lib/config';

export const dynamic = 'force-static';

export function GET() {
  return Response.json(openApiSpec(publicUrls()));
}
