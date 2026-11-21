# Native dependencies are installed for Linux, never copied from the host.
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY prisma/schema.prisma ./prisma/schema.prisma
# Enable only the native/generated packages needed by the locked application.
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm rebuild --ignore-scripts=false argon2 @prisma/client @prisma/engines esbuild
COPY backend ./backend
COPY frontend ./frontend
COPY prisma ./prisma
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_API_URL=/api
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Build needs a syntactically valid datasource, not a live database or a secret.
RUN DATABASE_URL='sqlserver://db:1433;database=Aprobis;user=build;password=unused;trustServerCertificate=true' \
    npm run db:generate
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
# Prisma CLI + tsx remain available for the one-shot migration/admin process.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/src ./backend/src
COPY --from=build /app/frontend/package.json /app/frontend/next.config.mjs ./frontend/
COPY --from=build --chown=node:node /app/frontend/.next ./frontend/.next
COPY --from=build /app/prisma ./prisma
COPY deployment/docker/*.mjs ./deployment/docker/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /data/storage /data/logs && chown -R node:node /data
USER node
EXPOSE 3000
ENTRYPOINT ["node", "deployment/docker/entrypoint.mjs"]
CMD ["web"]
