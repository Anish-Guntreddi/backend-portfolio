# Build context is the monorepo root so the @portfolio/shared and @portfolio/flagforge-core workspaces are available.
FROM node:24-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/flagforge-core/package.json packages/flagforge-core/package.json
COPY packages/flagforge/package.json packages/flagforge/package.json
RUN npm ci

# Copy source.
COPY packages/shared packages/shared
COPY packages/flagforge-core packages/flagforge-core
COPY packages/flagforge packages/flagforge

# Drop root: run as the unprivileged `node` user shipped in the base image.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
WORKDIR /app/packages/flagforge

# Apply migrations, then start the API. (tsx runs the TypeScript directly.)
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && npx tsx src/index.ts"]
