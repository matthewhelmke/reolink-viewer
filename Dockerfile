# ── Stage 1: TypeScript build ────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
# ubuntu:25.04 ships FFmpeg 7.1.1 in main — required for Reolink HEVC-in-FLV.
# (Ubuntu 24.04 LTS ships 6.1.1 which does not support codec-12; 7.0.2 is also
# insufficient — a post-7.0.2 git commit added the enhanced-FLV hvc1 support.)
FROM ubuntu:25.04 AS runtime

# Install Node.js 20 LTS (via NodeSource) and FFmpeg 7 in a single layer.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled server output and static frontend.
COPY --from=builder /build/dist ./dist
COPY public/ ./public/

ENV FFMPEG_PATH=/usr/bin/ffmpeg
EXPOSE 3000
CMD ["node", "dist/index.js"]
