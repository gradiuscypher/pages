import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { renderAdmin, renderDeleteConfirmation, renderError } from './render.js';

const digest = (value) => createHash('sha256').update(value).digest();

export function adminRouter({ password, store, pageJson }) {
  const router = express.Router();
  const expected = digest(`admin:${password}`);
  const csrf = randomBytes(32).toString('hex');
  router.use((req, res, next) => {
    const authorization = req.get('authorization') || '';
    const supplied = authorization.startsWith('Basic ') ? Buffer.from(authorization.slice(6), 'base64').toString('utf8') : '';
    if (!timingSafeEqual(expected, digest(supplied))) {
      res.set('WWW-Authenticate', 'Basic realm="Pages admin", charset="UTF-8"');
      return res.status(401).type('html').send(renderError(401, 'Admin authentication required.'));
    }
    // Only authenticated admin pages may submit forms; authored documents cannot.
    res.set('Content-Security-Policy', res.get('Content-Security-Policy').replace("form-action 'none'", "form-action 'self'"));
    next();
  });
  router.use(express.urlencoded({ extended: false, limit: '2kb' }));
  router.get('/', (req, res) => res.type('html').send(renderAdmin(store.list().map(pageJson))));
  router.get('/pages/:id/delete', (req, res) => {
    const page = store.get(req.params.id);
    if (!page) return res.status(404).type('html').send(renderError(404, 'Page not found.'));
    res.type('html').send(renderDeleteConfirmation(pageJson(page), csrf));
  });
  router.post('/pages/:id/delete', (req, res) => {
    if (req.get('sec-fetch-site') === 'cross-site' || typeof req.body?.csrf !== 'string' || !timingSafeEqual(digest(csrf), digest(req.body.csrf))) {
      return res.status(403).type('html').send(renderError(403, 'Invalid deletion confirmation.'));
    }
    if (!store.remove(req.params.id)) return res.status(404).type('html').send(renderError(404, 'Page not found.'));
    res.redirect(303, '/admin');
  });
  return router;
}
