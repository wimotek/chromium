# syntax=docker/dockerfile:1.7

# ==============================================================================
# Stage 1: Build Dependencies (native host architecture for fast multi-arch CI)
# ==============================================================================
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --include=dev; else npm install --include=dev; fi

# ==============================================================================
# Stage 2: Type-Check, Build Frontend (Vite) & Bundle Server (esbuild)
# Compiles strictly on $BUILDPLATFORM (no slow QEMU emulation on arm64 builds)
# Backend bundle is isolated in dist-server/server.mjs so express.static(dist/)
# never exposes server code.
# ==============================================================================
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build:all \
  && test -f dist/index.html \
  && test -f dist-server/server.mjs

# ==============================================================================
# Stage 3: Production Runtime Dependencies Only (dotenv, express, nodemailer)
# ==============================================================================
FROM --platform=$BUILDPLATFORM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

# ==============================================================================
# Stage 4: Minimal Production Runner (compiled output only, no TS source files)
# ==============================================================================
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HTTPS_PORT=3443 \
    DATA_DIR=/data \
    TLS_CERT_DIR=/certs

# su-exec stages root-owned Baota /certs:ro (0600) cleanly into a netpulse-owned 0600 directory,
# and openssl enables automatic/custom self-signed TLS generation when /certs:ro is not mounted.
RUN apk add --no-cache tini curl su-exec openssl \
  && addgroup -S -g 1001 netpulse \
  && adduser -S -u 1001 -G netpulse netpulse \
  && mkdir -p /data/certs /certs \
  && chown -R netpulse:netpulse /app /data

COPY --from=prod-deps --chown=netpulse:netpulse /app/node_modules ./node_modules
COPY --from=builder --chown=netpulse:netpulse /app/package.json ./package.json
COPY --from=builder --chown=netpulse:netpulse /app/dist ./dist
COPY --from=builder --chown=netpulse:netpulse /app/dist-server ./dist-server
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data", "/certs"]
EXPOSE 3000 3443

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist-server/server.mjs"]
