# whatsapp-mcp container image — one Node 24 process, ffmpeg and pdftotext.
#
# ⚠️ **Temporary, and workspace-shaped.** The tree is now a pnpm workspace, so this builds every
# package and runs `packages/api`'s entrypoint. That keeps the published image meaning exactly what
# it means today — the whole server, in-process MCP surface included — which stays true until the
# cutover removes it. Task 17 replaces this file with two real per-package images.
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
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm -r run build
# Prune to production. `pnpm prune --prod` is not workspace-recursive, so it is the wrong tool at a
# workspace root; a second `install --prod` is, and it drops typescript/tsx/eslint and every other
# devDependency out of `/app/node_modules` before the runtime stage copies it. It rebuilds the
# modules directory from the store rather than editing it, hence `confirmModulesPurge=false` — with
# no TTY pnpm otherwise refuses the removal instead of assuming consent. Task 17 replaces the whole
# arrangement with `pnpm deploy --filter <pkg> --prod`.
RUN pnpm --config.confirmModulesPurge=false install --frozen-lockfile --prod --ignore-scripts

# ── 2) Runtime ───────────────────────────────────────────────────────────────
FROM node:24-slim
# ffmpeg: keyframes, dimensions, durations, and the Opus transcode a video's audio track needs
# before it is uploaded for transcription. poppler-utils: pdftotext.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The workspace layout is preserved verbatim, not flattened: `packages/api`'s dependencies are
# symlinks inside `packages/api/node_modules` pointing at `../../node_modules/.pnpm/…`, and its
# `whatsapp-api-sdk` link points at `../../sdk`, so moving `dist/` up to `/app/dist` would leave both
# unresolvable at runtime. The copy is narrowed to exactly what `packages/api/dist/main.js` can
# reach: no package's `src/` ships, which is what keeps the 27 `*.test.ts` files and the two test
# scaffolding modules out of the image, and `packages/mcp` and `packages/e2e` are absent entirely.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=build /app/packages/api/package.json ./packages/api/package.json
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY package.json ./
RUN mkdir -p /data/whatsapp && chown -R node:node /data/whatsapp
ENV NODE_ENV=production \
    WHATSAPP_DATA_DIR=/data/whatsapp \
    PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/api/dist/main.js"]
