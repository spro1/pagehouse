# Build the web app, then ship only the server, its three runtime packages and the built assets.
FROM docker.io/library/node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:26-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="Pagehouse" \
      org.opencontainers.image.description="Self-hosted team wiki" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 APP_VERSION=${VERSION}
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/*.ts ./server/
COPY --from=build /app/server/migrations ./server/migrations
COPY package.json ./
# Patched OS packages, and no package managers at runtime: the app only needs `node`.
# npm, corepack and yarn ship with the base image and carry most of its CVEs (brace-expansion, glob, undici, ...).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && rm -f server/*.test.ts && mkdir -p /data && chown node:node /data \
 # Node bundles its own OpenSSL; the system one only serves apk and busybox's HTTPS client, neither used at runtime.
 && apk del --no-cache ssl_client libssl3 libcrypto3 apk-tools libapk
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server/index.ts"]
