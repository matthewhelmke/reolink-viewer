# ── Stage 1: TypeScript build ────────────────────────────────────────────────
FROM node:24-trixie-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
# Node 24 LTS on Debian 13 (trixie). Node comes from the base image, so no
# third-party apt repository is needed.
#
# Debian 13 ships FFmpeg 7.1.x with libx264, which recording playback requires.
# (Ubuntu 24.04 LTS ships 6.1.1, which does not support codec-12; 7.0.2 is also
# insufficient — a post-7.0.2 git commit added the enhanced-FLV hvc1 support.)
FROM node:24-trixie-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled server output and static frontend.
COPY --from=builder /build/dist ./dist
COPY public/ ./public/

# The server writes no files, so it runs as the image's unprivileged user.
USER node

ENV FFMPEG_PATH=/usr/bin/ffmpeg
EXPOSE 3000
CMD ["node", "dist/index.js"]
