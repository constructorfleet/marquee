# ---- Build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOME=/home/node \
    SQLITE_TMPDIR=/tmp
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev
COPY shared/src shared/src
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/client/dist client/dist
COPY docker-entrypoint.sh /usr/local/bin/

# /app stays root-owned so the app cannot rewrite its own code.
# Seeds /data ownership for new volumes; the entrypoint fixes existing ones.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown 1000:1000 /data

EXPOSE 3000
VOLUME /data
# Starts as root only long enough to fix /data ownership, then drops to uid 1000.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
