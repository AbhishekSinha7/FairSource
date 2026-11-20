# The dashboard as a self-contained Next.js server (standalone output). Build from the repo root:
#   docker build -f web/Dockerfile --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=... -t web .
# NEXT_PUBLIC_* values are baked into the browser code at build time, so they are build args.
FROM node:22-slim AS build
ARG NEXT_PUBLIC_FIREBASE_API_KEY=""
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=""
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID=""
ARG NEXT_PUBLIC_FAIRSOURCE_DOMAIN=""
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY . .
RUN npm ci --include-workspace-root -w packages/shared -w web
RUN npm run build -w packages/shared && npm run build -w web

FROM node:22-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./web/.next/static
USER node
CMD ["node", "web/server.js"]
