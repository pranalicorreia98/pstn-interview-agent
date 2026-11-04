# PSTN interview agent. glibc base (NOT alpine) — @livekit/rtc-node ships prebuilt
# glibc native binaries. Node 22+ required: livekit/rtc-node needs native WebSocket,
# which Node 20 doesn't have. npm install (not ci) so the linux-x64 optional native dep
# resolves regardless of which OS generated any lockfile.
FROM node:22-slim

# ca-certificates: the slim image omits the CA bundle, and @livekit/rtc-node's native
# (Rust/WebRTC) engine validates LiveKit cloud's TLS against the system store — without
# it the room connection fails with "invalid peer certificate: UnknownIssuer".
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
