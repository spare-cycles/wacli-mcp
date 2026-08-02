# whatsapp-mcp container image — one Node 24 process, ffmpeg, pdftotext, and a prebuilt whisper.cpp.
#
# There is no compiler in this file. The server is TypeScript, storage is `node:sqlite` (built in),
# and whisper.cpp arrives as binaries copied out of an upstream image — so the whole build is
# `pnpm install && tsc` plus two `COPY`s. Deliberate: a whisper.cpp compile stage would cost minutes
# per build and pull a C++ toolchain into a tree that otherwise has none.
#
# amd64 only, because the whisper.cpp image is amd64 only. That is the deployment target.
#
# Build and run (mount a volume for the store; the first run pairs — see README.md):
#   docker build -t whatsapp-mcp:latest .
#   docker run --rm -p 8080:8080 -v whatsapp-data:/data/whatsapp \
#     -e WHATSAPP_MCP_TOKEN=… -e WHATSAPP_PHONE_NUMBER=… whatsapp-mcp:latest

# ── 1) whisper.cpp binaries (prebuilt, amd64) ────────────────────────────────
# Pinned by digest: the :main tag moves. Ubuntu 22.04/glibc 2.35 -> bookworm/2.36 is forward-compatible.
FROM ghcr.io/ggml-org/whisper.cpp@sha256:375cf0e9e4b5598454493878ce09c4de72ed3e4ed8f41e77a25e1acd9b4112b5 AS whisper

# ── 2) Build the server ──────────────────────────────────────────────────────
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ── 3) Runtime ───────────────────────────────────────────────────────────────
FROM node:24-slim
# ffmpeg: keyframes, wav conversion, voice notes. poppler-utils: pdftotext.
# libgomp1: required by whisper-cli, absent from node:*-slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# whisper-cli is dynamically linked against libwhisper/libggml* living beside it — copy the directory.
COPY --from=whisper /app/build/bin /opt/whisper/bin
ENV LD_LIBRARY_PATH=/opt/whisper/bin
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data/whatsapp && chown -R node:node /data/whatsapp
ENV NODE_ENV=production \
    WHATSAPP_DATA_DIR=/data/whatsapp \
    WHATSAPP_WHISPER_BIN=/opt/whisper/bin/whisper-cli \
    PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
