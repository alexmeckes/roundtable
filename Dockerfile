FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY server.js ./
COPY agents ./agents
COPY public ./public

# Rooms persist here — mount a volume at /data and keep this env var.
ENV ROUNDTABLE_DATA=/data/rooms.json
ENV NODE_ENV=production

EXPOSE 3131
CMD ["node", "server.js"]
