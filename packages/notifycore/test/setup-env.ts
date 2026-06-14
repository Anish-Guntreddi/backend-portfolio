// Default test environment pointing at the docker-compose services on their host ports.
process.env.DATABASE_URL ??= 'postgres://notifycore:notifycore@localhost:5436/notifycore';
process.env.REDIS_URL ??= 'redis://localhost:6381';
process.env.API_KEY ??= 'dev-notifycore-key';
process.env.LOG_LEVEL ??= 'silent';
process.env.RETRY_BASE_MS ??= '50';
process.env.DEFAULT_MAX_ATTEMPTS ??= '5';
