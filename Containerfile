# syntax=docker/dockerfile:1
FROM docker.io/library/node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY admin-ui ./admin-ui
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:24-alpine
LABEL org.opencontainers.image.title="infomaniak-mcp-server" \
      org.opencontainers.image.description="Remote MCP server exposing the whole Infomaniak API" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 ADMIN_PORT=9090 DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# 3000: MCP endpoint (public) · 9090: admin portal (keep private)
EXPOSE 3000 9090
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/index.js"]
