import express from 'express';
import multer from 'multer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { renderHome, renderPage, renderError } from './render.js';

const staticDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest();
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

function documentInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { title, description = '', markdown } = body;
  if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
      typeof description !== 'string' || description.length > 500 ||
      typeof markdown !== 'string' || Buffer.byteLength(markdown) > 1024 * 1024) return null;
  return { title: title.trim(), description: description.trim(), markdown };
}

// Only inert raster formats render inline. Client-supplied MIME types are not trusted.
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

export function createApp({ apiKey, publicUrl, dataDir, maxUploadBytes = 25 * 1024 * 1024 }) {
  if (typeof apiKey !== 'string' || apiKey.length < 24) throw new Error('PAGES_API_KEY must contain at least 24 characters.');
  const origin = new URL(publicUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_URL must be an http(s) origin without a path or credentials.');
  }
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) throw new Error('MAX_UPLOAD_MB must be a positive whole number.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = openStore(resolve(dataDir, 'pages.sqlite'));
  const app = express();
  app.disable('x-powered-by');
  const expectedKey = digest(apiKey);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 1, fieldNameSize: 100, headerPairs: 100 },
  }).single('file');
  const assetJson = (asset) => {
    const url = `${origin.origin}/assets/${asset.id}/${encodeURIComponent(asset.name)}`;
    return { ...asset, url, downloadUrl: `${url}?download=1` };
  };
  const pageJson = (page) => ({
    ...page,
    url: `${origin.origin}/p/${page.id}`,
    ...(page.assets ? { assets: page.assets.map(assetJson) } : {}),
  });
  const fail = (res, status, error) => res.status(status).json({ error });

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    });
    next();
  });
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.use('/static', express.static(staticDirectory, { index: false, dotfiles: 'deny' }));
  app.get('/', (req, res) => res.type('html').send(renderHome()));

  app.use('/api', (req, res, next) => {
    const authorization = req.get('authorization') || '';
    if (!authorization.startsWith('Bearer ') || !timingSafeEqual(expectedKey, digest(authorization.slice(7)))) {
      res.set('WWW-Authenticate', 'Bearer');
      return fail(res, 401, 'A valid Bearer API key is required.');
    }
    next();
  }, express.json({ limit: '1100kb', strict: true }));
  app.get('/api/pages', (req, res) => res.json({ pages: store.list().map(pageJson) }));
  app.post('/api/pages', (req, res) => {
    const input = documentInput(req.body);
    if (!input) return fail(res, 400, 'Expected title (1–200 characters), description (up to 500 characters), and markdown (up to 1 MiB).');
    const page = pageJson(store.create(input));
    res.location(page.url).status(201).json(page);
  });
  app.use('/api/pages/:id', (req, res, next) => {
    const page = store.get(req.params.id);
    if (!page) return fail(res, 404, 'Page not found.');
    res.locals.page = page;
    next();
  });
  app.get('/api/pages/:id', (req, res) => res.json(pageJson(res.locals.page)));
  app.put('/api/pages/:id', (req, res) => {
    const input = documentInput(req.body);
    if (!input) return fail(res, 400, 'Expected title (1–200 characters), description (up to 500 characters), and markdown (up to 1 MiB).');
    res.json(pageJson(store.update(req.params.id, input)));
  });
  app.delete('/api/pages/:id', (req, res) => {
    store.remove(req.params.id);
    res.status(204).end();
  });
  app.post('/api/pages/:id/assets', upload, (req, res) => {
    if (!req.file) return fail(res, 400, 'Upload one file using multipart field "file".');
    const name = basename(req.file.originalname.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
    if (!name || name === '.' || name === '..') return fail(res, 400, 'A filename is required.');
    const asset = assetJson(store.addAsset(req.params.id, name, imageMime(req.file.buffer), req.file.buffer));
    res.location(asset.url).status(201).json(asset);
  });
  app.delete('/api/pages/:id/assets/:assetId', (req, res) => {
    if (!store.removeAsset(req.params.id, req.params.assetId)) return fail(res, 404, 'Attachment not found on this page.');
    res.status(204).end();
  });
  app.use('/api', (req, res) => fail(res, 404, 'API route not found.'));

  app.get('/p/:id', (req, res) => {
    const page = store.get(req.params.id);
    if (!page) return res.status(404).type('html').send(renderError(404, 'Page not found.'));
    res.type('html').send(renderPage(pageJson(page)));
  });
  app.get('/p/:id/source.md', (req, res) => {
    const page = store.get(req.params.id);
    if (!page) return res.status(404).type('html').send(renderError(404, 'Page not found.'));
    res.attachment(`${page.id}.md`).type('text/markdown').send(page.markdown);
  });
  app.get('/assets/:id/:name', (req, res) => {
    const asset = store.getAsset(req.params.id);
    if (!asset || asset.name !== req.params.name) return res.status(404).type('html').send(renderError(404, 'Attachment not found.'));
    res.attachment(asset.name);
    if (asset.mime.startsWith('image/') && req.query.download !== '1') {
      res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
    }
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(asset.mime).send(Buffer.from(asset.content.buffer, asset.content.byteOffset, asset.content.byteLength));
  });
  app.use((req, res) => res.status(404).type('html').send(renderError(404, 'Page not found.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      return fail(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        error.code === 'LIMIT_FILE_SIZE' ? `File exceeds the ${maxUploadBytes}-byte upload limit.` : 'Upload exactly one file using multipart field "file".');
    }
    if (error.type === 'entity.too.large') return fail(res, 413, 'Request body is too large.');
    if (error instanceof SyntaxError && error.type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON.');
    if (error instanceof URIError || error.message === 'Unexpected end of form') return fail(res, 400, 'Malformed request.');
    console.error('Request failed:', error.message);
    if (req.path.startsWith('/api/')) return fail(res, 500, 'Internal server error.');
    res.status(500).type('html').send(renderError(500, 'Internal server error.'));
  });
  return { app, close: () => store.close() };
}
