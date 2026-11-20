import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@fairsource/shared'],
  // Self-contained server for the container (web/Dockerfile). Tracing from the repo
  // root lets it include the shared workspace package.
  output: 'standalone',
  outputFileTracingRoot: path.join(process.cwd(), '..'), // next build runs in web/
};

export default config;
