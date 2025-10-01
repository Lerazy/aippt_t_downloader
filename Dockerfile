# Production Dockerfile for AiPPT downloader

FROM node:20-bullseye AS base

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev --no-fund --no-audit

# Playwright chromium and its system deps (postinstall also runs, but we ensure here)
RUN npx --yes playwright install --with-deps chromium || true

# Copy source
COPY src ./src
COPY data ./data

# Persist data across container restarts
VOLUME ["/app/data"]

# App port (can be overridden by -e PORT=xxxx)
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]


