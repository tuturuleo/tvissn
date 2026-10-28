FROM node:24-alpine AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /srv
COPY --from=build --chown=node:node /srv/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/package.json ./package.json
COPY --from=build --chown=node:node /srv/dist ./dist
COPY --from=build --chown=node:node /srv/server ./server
COPY --from=build --chown=node:node /srv/extension/identity.json ./extension/identity.json
COPY --from=build --chown=node:node /srv/migrations ./migrations
USER node
EXPOSE 10000
CMD ["npm", "start"]
