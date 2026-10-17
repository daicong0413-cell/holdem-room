FROM node:24-bookworm-slim AS web-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY src ./src
COPY tsconfig.json vite.config.ts ./
RUN npm run build:web

FROM node:24-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/check-deployment.mjs ./scripts/check-deployment.mjs
COPY --from=web-build --chown=node:node /app/dist/web ./dist/web
COPY LICENSE ./LICENSE

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server/main.ts"]
