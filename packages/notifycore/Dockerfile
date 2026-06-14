# Build context is the monorepo root so the @portfolio/shared and @portfolio/notifycore-core workspaces are available.
FROM node:24-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/notifycore-core/package.json packages/notifycore-core/package.json
COPY packages/notifycore/package.json packages/notifycore/package.json
RUN npm ci

# Copy source.
COPY packages/shared packages/shared
COPY packages/notifycore-core packages/notifycore-core
COPY packages/notifycore packages/notifycore

# Drop root: run as the unprivileged `node` user shipped in the base image.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
WORKDIR /app/packages/notifycore

# Apply migrations, then start the API. (tsx runs the TypeScript directly.)
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && npx tsx src/index.ts"]
