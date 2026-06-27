# wacli-mcp container image — the MCP server + a self-built Linux `wacli` binary + ffmpeg.
#
# Multi-stage, glibc (Debian bookworm) throughout: wacli needs CGO (go-sqlite3) so the binary is
# dynamically linked against glibc — building it on bookworm and running it on node:22-bookworm-slim
# keeps the ABI compatible (an Alpine/musl runtime would not load it).
#
# Build (pin a wacli release tag for reproducibility):
#   docker build --build-arg WACLI_REF=v0.5.0 -t ghcr.io/spare-cycles/wacli-mcp:0.1.0 .
#
# Run (HTTP mode is the image default; mount an authenticated store):
#   docker run --rm -p 8080:8080 -v wacli-store:/data/wacli ghcr.io/spare-cycles/wacli-mcp:0.1.0
# One-time WhatsApp auth (interactive QR) against the same store:
#   docker run --rm -it -v wacli-store:/data/wacli ghcr.io/spare-cycles/wacli-mcp:0.1.0 \
#     wacli --store /data/wacli auth

# ── 1) Build the Linux wacli binary (CGO + sqlite_fts5) ──────────────────────
FROM golang:1.25-bookworm AS wacli
ARG WACLI_REPO=https://github.com/openclaw/wacli
ARG WACLI_REF=main
RUN apt-get update \
 && apt-get install -y --no-install-recommends git build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WACLI_REF" "$WACLI_REPO" /src
WORKDIR /src
# CGO flags mirror wacli's own build (see its README): sqlite_fts5 enables FTS5 full-text search.
RUN CGO_ENABLED=1 CGO_CFLAGS="-Wno-error=missing-braces" \
    go build -tags sqlite_fts5 -o /out/wacli ./cmd/wacli

# ── 2) Build the MCP server (pnpm -> tsc -> dist) ────────────────────────────
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json server.ts sync-supervisor.ts send-file.ts ./
RUN pnpm build && pnpm prune --prod

# ── 3) Runtime ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
# ffmpeg/ffprobe are needed by wacli for media sends; ca-certificates for TLS to WhatsApp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=wacli /out/wacli /usr/local/bin/wacli
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Created here for standalone runs; the store is normally a bind mount chown'd to 1000 by an
# init sidecar (see the portainer-setup mcp-servers stack).
RUN mkdir -p /data/wacli
ENV NODE_ENV=production \
    WACLI_BIN=/usr/local/bin/wacli \
    WACLI_STORE_DIR=/data/wacli \
    WACLI_MCP_HTTP=1 \
    PORT=8080
USER node
EXPOSE 8080
# No ENTRYPOINT, so `docker run … wacli --store /data/wacli auth` can override the command for auth.
CMD ["node", "dist/server.js"]
