// Default test environment. Override by exporting these vars before running `npm test`.
// Points at the docker-compose Postgres on host port 5435.
process.env.DATABASE_URL ??= 'postgres://flagforge:flagforge@localhost:5435/flagforge';
process.env.API_KEY ??= 'dev-flagforge-key';
process.env.LOG_LEVEL ??= 'silent';
// Leave REDIS_URL unset so tests use NullCache and don't require Redis.
