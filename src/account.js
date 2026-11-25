import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { renderAccount, renderError, renderLibrary, renderNewKey } from './render.js';

const fail = (res, status, message) => res.status(status).type('html').send(renderError(status, message));

export function accountRouter({ store }) {
  const router = express.Router();
  const secret = randomBytes(32);
  const csrfToken = (username) => createHmac('sha256', secret).update(username).digest('hex');

  router.use(['/account', '/library'], async (req, res, next) => {
    const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(req.get('authorization') || '');
    const credentials = match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
    const colon = credentials.indexOf(':');
    const username = credentials.slice(0, colon);
    if (colon < 1 || !await store.verifyUser(username, credentials.slice(colon + 1))) {
      res.set('WWW-Authenticate', 'Basic realm="Pages account", charset="UTF-8"');
      return fail(res, 401, 'Sign in with your Pages account.');
    }
    res.locals.username = username;
    next();
  });

  router.get('/library', (req, res) => res.type('html').send(renderLibrary(store.list())));

  router.use('/account', express.urlencoded({ extended: false, limit: '4kb' }), (req, res, next) => {
    const csrf = csrfToken(res.locals.username);
    if (req.method === 'POST') {
      const submitted = req.body?.csrf;
      if (req.get('sec-fetch-site') === 'cross-site' || typeof submitted !== 'string' ||
          Buffer.byteLength(submitted) !== csrf.length || !timingSafeEqual(Buffer.from(submitted), Buffer.from(csrf))) {
        return fail(res, 403, 'Invalid form token. Reload your account and try again.');
      }
    }
    res.locals.csrf = csrf;
    res.set('Content-Security-Policy', res.get('Content-Security-Policy').replace("form-action 'none'", "form-action 'self'"));
    next();
  });
  router.get('/account', (req, res) => {
    const { username, csrf } = res.locals;
    res.type('html').send(renderAccount({ username, csrf, keys: store.listKeys(username), groups: store.listGroups(username), pages: store.list(username) }));
  });
  router.post('/account/keys', (req, res) => {
    const key = store.createKey(res.locals.username);
    res.status(201).type('html').send(renderNewKey(key));
  });
  router.post('/account/keys/:id/revoke', (req, res) => {
    if (!store.revokeKey(res.locals.username, req.params.id)) return fail(res, 404, 'Key not found.');
    res.redirect(303, '/account');
  });
  router.post('/account/groups', (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) return fail(res, 400, 'Group names must contain 1–100 characters.');
    if (!store.createGroup(res.locals.username, name)) return fail(res, 409, 'You already have a group with that name.');
    res.redirect(303, '/account');
  });
  router.post('/account/pages/group', (req, res) => {
    const { pageId, groupId } = req.body;
    const { username } = res.locals;
    if (typeof pageId !== 'string' || typeof groupId !== 'string') return fail(res, 400, 'Select a document and a group.');
    const page = store.get(pageId);
    if (!page || page.owner !== username) return fail(res, 404, 'Document not found.');
    if (groupId && !store.hasGroup(username, groupId)) return fail(res, 404, 'Group not found.');
    store.setGroup(pageId, groupId || null);
    res.redirect(303, '/account');
  });
  return router;
}
