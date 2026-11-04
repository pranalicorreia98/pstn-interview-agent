# PSTN interview agent. glibc base (NOT alpine) — @livekit/rtc-node ships prebuilt
# glibc native binaries. Node 22+ required: livekit/rtc-node needs native WebSocket,
# which Node 20 doesn't have. npm install (not ci) so the linux-x64 optional native dep
# resolves regardless of which OS generated any lockfile.
FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
