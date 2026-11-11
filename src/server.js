import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 25);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
if (!Number.isSafeInteger(maxUploadMb) || maxUploadMb < 1) throw new Error('MAX_UPLOAD_MB must be a positive whole number.');
const host = process.env.HOST || '127.0.0.1';
const { app, close } = createApp({
  apiKey: process.env.PAGES_API_KEY,
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${port}`,
  dataDir: process.env.DATA_DIR || './data',
  maxUploadBytes: maxUploadMb * 1024 * 1024,
});
const server = app.listen(port, host, () => console.log(`Pages listening at http://${host}:${port}`));
server.on('error', (error) => { close(); console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => { close(); });
    server.closeIdleConnections();
  });
}
