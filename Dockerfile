# Multi-stage so the runtime image carries no TypeScript, no test framework and
# no build tooling. Smaller image, smaller attack surface, faster cold starts.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# Never run as root. The container needs to read its own code and talk to the
# network, and nothing else.
USER node

# Overridden per service in docker-compose.yml.
CMD ["node", "dist/runtime/poller.js"]
