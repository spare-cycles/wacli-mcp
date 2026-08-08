# whatsapp-api — Baileys, the SQLite store, the media pipeline and the REST surface.
#
# Build from the **workspace root**, not from this directory: a workspace install needs the root
# lockfile, `pnpm-workspace.yaml` and every package manifest, so the context is `.` and the file is
# chosen with `-f`.
#
#   docker build -f packages/api/Dockerfile -t whatsapp-api:latest .
#   docker run --rm -p 8080:8080 -v whatsapp-data:/data/whatsapp \
#     -e WHATSAPP_API_TOKEN=… -e WHATSAPP_PHONE_NUMBER=… whatsapp-api:latest
#
# `whatsapp-api-sdk` is built from workspace source and never installed from a registry. A registry
# dependency at image-build time would reintroduce the publish-then-bump dance the monorepo exists to
# avoid — the SDK's whole value is that both sides compile against one tree.
#
# ⚠️ **whisper.cpp used to live here and is gone.** Transcription runs on a RunPod serverless
# endpoint (Voxtral Small 24B on an A100), so the prebuilt stage, its ~200 MB of binaries, `libgomp1`
# and `LD_LIBRARY_PATH` all left with it — along with the amd64-only constraint that imposed. What did
# NOT leave is ffmpeg: it still transcodes a video's audio track before upload, and poppler-utils
# still backs `pdftotext`.

# ── 1) Build the workspace ───────────────────────────────────────────────────
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm -r run build

# Resolve just this package's production closure into a self-contained directory.
#
# `pnpm deploy` is the workspace-aware tool here; `pnpm prune --prod` is not workspace-recursive and
# is the wrong instrument at a workspace root.
#
# `--legacy` is required and is a deliberate choice over the alternative. From pnpm 10, `deploy`
# refuses a workspace that does not set `inject-workspace-packages=true` — but injecting would change
# how workspace dependencies link **in development too**, turning the SDK from a symlink into a
# hard-copy that goes stale until the next install. That is a real cost paid on every SDK edit, to
# satisfy a flag that only matters inside this image. `--legacy` keeps the dev workflow untouched.
#
# What this buys over hand-copying the workspace layout: `whatsapp-api-sdk` arrives as a real
# dependency of the deployed tree, so a `zod` import *inside the SDK* resolves from the deploy's own
# store. Node resolves realpaths, so under a preserved workspace layout that import restarts its walk
# at `packages/sdk` and needs `packages/sdk/node_modules` copied in by hand — a line whose absence
# fails only once the SDK imports something. This arrangement cannot have that bug.
RUN pnpm deploy --filter whatsapp-api --prod --legacy /out

# ── 2) Runtime ───────────────────────────────────────────────────────────────
FROM node:24-slim
# ffmpeg: keyframes, dimensions, durations, and the Opus transcode a video's audio track needs before
# it is uploaded for transcription. poppler-utils: pdftotext.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /data/whatsapp && chown -R node:node /data/whatsapp
ENV NODE_ENV=production \
    WHATSAPP_DATA_DIR=/data/whatsapp \
    PORT=8080
USER node
EXPOSE 8080
# The restart signal every orchestrator relies on. `ok` is false when the account is logged out —
# a state no amount of waiting fixes and a human has to re-pair — so an unhealthy container here
# means "come look", not "restart me".
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
