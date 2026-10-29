FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --fetch-timeout=30000 --fetch-retries=1 --fetch-retry-mintimeout=2000
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --fetch-timeout=30000 --fetch-retries=1

FROM node:24-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src/domain ./src/domain
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "server/index.ts"]
