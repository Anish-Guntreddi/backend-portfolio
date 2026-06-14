// Default test environment. Override by exporting these vars before running `npm test`.
// Points at the docker-compose Postgres on host port 5434.
process.env.DATABASE_URL ??= 'postgres://audittrail:audittrail@localhost:5434/audittrail';
process.env.APP_DATABASE_URL ??= 'postgres://audittrail_app:audittrail_app@localhost:5434/audittrail';
process.env.API_KEY ??= 'dev-audittrail-key';
process.env.LOG_LEVEL ??= 'silent';
