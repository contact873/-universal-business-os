// Imported first by every test file. config.mjs reads process.env at module load, so these
// values have to be in place before it is evaluated. Keeping them here rather than scattered
// means the tests describe one environment instead of several.

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-not-for-production";
process.env.APP_URL = process.env.APP_URL || "http://127.0.0.1:3000";
process.env.PLATFORM_ADMIN_EMAILS = process.env.PLATFORM_ADMIN_EMAILS || "admin@example.test";
delete process.env.VERCEL;
delete process.env.DATABASE_URL;
