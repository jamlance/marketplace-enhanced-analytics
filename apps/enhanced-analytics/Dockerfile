# Multi-stage build for the Enhanced Analytics embedded app.
#
# Build context is the monorepo root (Coolify base_directory = /).
#
# The builder installs the FULL workspace and runs vite build. The
# runtime copies the entire workspace (so workspace:* deps resolve)
# plus the dist + server. Pnpm-managed symlinks in node_modules make
# `import "@bookerva-apps/core"` work at runtime without re-resolving.

# --------------------------------------------------------------- builder
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9

COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/enhanced-analytics ./apps/enhanced-analytics

RUN pnpm install --no-frozen-lockfile

WORKDIR /work/apps/enhanced-analytics
RUN pnpm exec vite build

# --------------------------------------------------------------- runtime
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git

# Bring the resolved workspace + node_modules over so the app can
# `import "@bookerva-apps/core"` without another install.
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/enhanced-analytics/package.json ./apps/enhanced-analytics/package.json
COPY --from=builder /work/apps/enhanced-analytics/node_modules ./apps/enhanced-analytics/node_modules
COPY --from=builder /work/apps/enhanced-analytics/dist ./apps/enhanced-analytics/dist

COPY apps/enhanced-analytics/server.js ./apps/enhanced-analytics/server.js

EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/enhanced-analytics
CMD ["node", "server.js"]
