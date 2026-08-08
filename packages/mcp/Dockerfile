# whatsapp-mcp — the MCP surface, and nothing else.
#
# Build from the **workspace root**, not from this directory: a workspace install needs the root
# lockfile, `pnpm-workspace.yaml` and every package manifest, so the context is `.` and the file is
# chosen with `-f`.
#
#   docker build -f packages/mcp/Dockerfile -t whatsapp-mcp:latest .
#   docker run --rm -p 8081:8080 \
#     -e WHATSAPP_API_URL=http://api:8080 -e WHATSAPP_API_TOKEN=… whatsapp-mcp:latest
#
# ⚠️ **There is no `apt-get` line in this file, and that absence is the point of the split.** This
# process transcodes nothing, reads no PDF, opens no database and speaks no WhatsApp protocol — it
# turns tool calls into HTTP requests. So it carries no ffmpeg, no poppler-utils, no `/data` volume
# and no state: it is a stateless consumer of `whatsapp-api`, and losing it costs a reconnect.
# Anything that would put a system binary in here belongs behind the API instead.
#
# `whatsapp-api-sdk` is built from workspace source and never installed from a registry — see
# `packages/api/Dockerfile` for why, and for why `pnpm deploy` runs with `--legacy`.

# ── 1) Build the workspace ───────────────────────────────────────────────────
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm -r run build
RUN pnpm deploy --filter whatsapp-mcp --prod --legacy /out

# ── 2) Runtime ───────────────────────────────────────────────────────────────
FROM node:24-slim
WORKDIR /app
COPY --from=build /out ./
ENV NODE_ENV=production \
    PORT=8080
USER node
EXPOSE 8080
# Same parameters as the API's, deliberately: an orchestrator should not have to learn two schedules.
#
# This `ok` means something different from the API's, and the difference is intended. The API's says
# "the WhatsApp account is usable"; this one says "and I can reach the API" — an MCP that cannot
# reach its API serves nothing, so it reports itself unhealthy and lets the orchestrator restart it.
# The `whatsapp_health` *tool* does not fold the two together: it still answers with the API's own
# meaning, so a model is never told the account is logged out when the truth is a network partition.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
