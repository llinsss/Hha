# syntax=docker/dockerfile:1.7
# Node >= 24.11 is required by TypeORM 1.x.
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini
# "::" accepts IPv4 and IPv6, so private networks such as Railway's (IPv6) can reach the API.
ENV NODE_ENV=production \
    HOST=:: \
    PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM so the server drains connections before exiting.
# Other entry points in the same image: node dist/scripts/migrate.js up,
# node dist/scripts/run-job.js <expire-payment-holds|reconcile-payments>.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
