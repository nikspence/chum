import { createApp } from './app.js';

const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
if (process.env.COOKIE_SECURE && !['true', 'false'].includes(process.env.COOKIE_SECURE)) throw new Error('COOKIE_SECURE must be true or false.');
const app = await createApp({
  dataDir: process.env.DATA_DIR,
  origin: process.env.PUBLIC_ORIGIN || `http://localhost:${port}`,
  adminPassword: process.env.CHUM_ADMIN_PASSWORD,
  secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : undefined,
  maxUpload: Number(process.env.MAX_UPLOAD_BYTES || 1073741824),
  sessionHours: Number(process.env.SESSION_HOURS || 168),
  cleanupInterval: Number(process.env.CLEANUP_INTERVAL_MS || 60000),
});
app.server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`chumbucket listening on ${process.env.HOST || '127.0.0.1'}:${port}`));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  try { await app.close(); } catch (error) { console.error(error); process.exitCode = 1; }
});
