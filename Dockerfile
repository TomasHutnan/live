FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries, so no compiler or install scripts are needed.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY scripts/hash-password.mjs ./scripts/hash-password.mjs
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8090
CMD ["node", "dist/server.js"]
