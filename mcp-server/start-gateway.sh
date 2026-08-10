#!/usr/bin/env bash
# Starts the VoiceBridge MCP gateway and restarts it if it dies.
#
# VoiceOS talks HTTP, server.ts talks stdio, so supergateway bridges them.
# It has crashed mid-session on a socket read error; without a restart loop
# that takes every phone tool offline until someone notices.
#
#   ./start-gateway.sh
#
# Then point VoiceOS at http://localhost:8787/mcp

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE_BIN:-$(command -v node)}"

export CONVEX_URL="${CONVEX_URL:-https://helpful-donkey-68.convex.cloud}"
# How long one wait_for_phone_request call blocks. Longer means fewer manual
# "listen to my phone" triggers; 240s is verified working through the transport.
export LISTEN_WINDOW_MS="${LISTEN_WINDOW_MS:-240000}"

PORT="${PORT:-8787}"

if [ -z "$NODE" ]; then
  echo "node not found. Set NODE_BIN=/path/to/node and retry." >&2
  exit 1
fi

echo "VoiceBridge gateway"
echo "  convex : $CONVEX_URL"
echo "  listen : $((LISTEN_WINDOW_MS / 1000))s window"
echo "  url    : http://localhost:$PORT/mcp"
echo

while true; do
  npx -y supergateway \
    --stdio "$NODE $HERE/node_modules/tsx/dist/cli.mjs $HERE/server.ts" \
    --outputTransport streamableHttp \
    --streamableHttpPath /mcp \
    --port "$PORT"

  code=$?
  echo
  echo "gateway exited (code $code) — restarting in 2s. Ctrl-C to stop." >&2
  sleep 2
done
