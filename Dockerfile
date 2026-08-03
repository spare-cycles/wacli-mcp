# whatsapp-mcp container image — one Node 24 process, ffmpeg and pdftotext.
#
# There is no compiler in this file: the server is TypeScript and storage is `node:sqlite` (built
# in), so the whole build is `pnpm install && tsc`.
#
# ⚠️ **whisper.cpp used to live here and is gone.** Transcription runs on a RunPod serverless
# endpoint now (Voxtral Small 24B on an A100), so the prebuilt whisper.cpp stage, the ~200 MB of
# binaries it copied in, `libgomp1` and `LD_LIBRARY_PATH` all left with it — along with the amd64-only
# constraint that image imposed, which is why this now builds for arm64 too. What did NOT leave is
# ffmpeg: it still transcodes a video's audio track before upload, and poppler-utils still backs
# `pdftotext`.
#
# Build and run (mount a volume for the store; the first run pairs — see README.md):
#   docker build -t whatsapp-mcp:latest .
#   docker run --rm -p 8080:8080 -v whatsapp-data:/data/whatsapp \
#     -e WHATSAPP_MCP_TOKEN=… -e WHATSAPP_PHONE_NUMBER=… whatsapp-mcp:latest

# ── 1) Build the server ──────────────────────────────────────────────────────
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ── 2) Runtime ───────────────────────────────────────────────────────────────
FROM node:24-slim
# ffmpeg: keyframes, dimensions, durations, and the Opus transcode a video's audio track needs
# before it is uploaded for transcription. poppler-utils: pdftotext.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data/whatsapp && chown -R node:node /data/whatsapp
ENV NODE_ENV=production \
    WHATSAPP_DATA_DIR=/data/whatsapp \
    PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
