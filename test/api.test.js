import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { openStore } from '../src/store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pages-test-'));
  const options = { publicUrl: 'https://pages.internal', dataDir, maxUploadBytes: 1024, ...overrides };
  const store = openStore(join(dataDir, 'pages.sqlite'));
  store.createUser('alice', 'test-password');
  store.createUser('bob', 'test-password');
  const { key } = store.createKey('alice');
  const otherKey = store.createKey('bob').key;
  store.close();
  let instance;
  let server;
  let base;
  async function start() {
    instance = createApp(options);
    server = instance.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    instance.close();
  }
  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    key, otherKey,
    request: (path, init = {}) => fetch(`${base}${path}`, {
      ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers },
    }),
    async create(markdown = '## Evidence\n\nA useful report.') {
      const response = await this.request('/api/pages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Report', description: 'System findings', markdown }),
      });
      assert.equal(response.status, 201);
      return response.json();
    },
    async upload(page, content, name = 'report.html', type = 'text/html') {
      const body = new FormData();
      body.append('file', new Blob([content], { type }), name);
      return this.request(`/api/pages/${page.id}/assets`, { method: 'POST', body });
    },
    restart: async () => { await stop(); await start(); },
  };
}

test('API requires the exact key, including reads, before accepting input', async (t) => {
  const f = await fixture(t);
  for (const authorization of ['', 'Bearer wrong', `Basic ${f.key}`, `Bearer ${f.key}extra`]) {
    const response = await f.request('/api/pages', { headers: { Authorization: authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  }
  assert.equal((await f.request('/api/pages')).status, 200);
  assert.equal((await f.request('/api/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await f.request('/api/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"  ","markdown":""}' })).status, 400);
});

test('documents persist, replace content, and expose public pages without exposing the index', async (t) => {
  const f = await fixture(t);
  const page = await f.create();
  assert.equal(page.url, `https://pages.internal/p/${page.id}`);
  await f.restart();
  assert.equal((await (await f.request(`/api/pages/${page.id}`)).json()).markdown, page.markdown);
  const response = await f.request(`/api/pages/${page.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Revised report', description: 'Updated summary', markdown: '## Updated\n\nNew evidence.' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).description, 'Updated summary');
  const html = await f.request(`/p/${page.id}`, { headers: { Authorization: '' } });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Revised report/);
  const source = await f.request(`/p/${page.id}/source.md`, { headers: { Authorization: '' } });
  assert.equal(await source.text(), '## Updated\n\nNew evidence.');
  assert.match(source.headers.get('content-disposition'), /^attachment/);
  assert.doesNotMatch(await (await f.request('/')).text(), /Revised report/);
});

test('HTML uploads cannot execute inline; raster images can render and force download', async (t) => {
  const f = await fixture(t);
  const page = await f.create();
  const htmlResponse = await f.upload(page, '<script>alert(1)</script>', 'hostile.html', 'image/png');
  assert.equal(htmlResponse.status, 201);
  const asset = await htmlResponse.json();
  const download = await f.request(new URL(asset.url).pathname);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.match(download.headers.get('content-type'), /application\/octet-stream/);
  assert.equal(await download.text(), '<script>alert(1)</script>');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6X1kAAAAASUVORK5CYII=', 'base64');
  const imageResponse = await f.upload(page, png, 'plot.png');
  assert.equal(imageResponse.status, 201);
  const image = await imageResponse.json();
  const inline = await f.request(new URL(image.url).pathname);
  assert.equal(inline.headers.get('content-type'), 'image/png');
  assert.match(inline.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(Buffer.from(await inline.arrayBuffer()), png);
  assert.match((await f.request(new URL(image.downloadUrl).pathname + '?download=1')).headers.get('content-disposition'), /^attachment/);
  await f.restart();
  assert.equal((await (await f.request(`/api/pages/${page.id}`)).json()).assets.length, 2);
  assert.equal((await f.upload(page, Buffer.alloc(1025))).status, 413);
});

test('deleting a page removes its attachments; attachment deletion is scoped to its owner', async (t) => {
  const f = await fixture(t);
  const page = await f.create();
  const other = await f.create();
  const asset = await (await f.upload(page, 'evidence')).json();
  assert.equal((await f.request(`/api/pages/${other.id}/assets/${asset.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await f.request(`/api/pages/${page.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await f.request(`/api/pages/${page.id}`)).status, 404);
  assert.equal((await f.request(new URL(asset.url).pathname)).status, 404);
  assert.equal((await f.request(`/api/pages/${other.id}`)).status, 200);
});

test('agent delete handles empty success, auth failures, and missing pages', async (t) => {
  const f = await fixture(t);
  const page = await f.create();
  const other = await f.create();
  const asset = await (await f.upload(page, 'evidence')).json();
  const base = new URL((await f.request('/healthz')).url).origin;
  const helper = new URL('../skills/publish-pages/scripts/pages.py', import.meta.url).pathname;
  const env = { ...process.env, PAGES_URL: base, PAGES_API_KEY: f.key };
  await assert.rejects(runFile('python3', [helper, 'delete', page.id], {
    env: { ...env, PAGES_API_KEY: 'wrong-key' },
  }), (error) => error.code === 1 && /HTTP 401/.test(error.stderr));
  assert.equal((await f.request(`/api/pages/${page.id}`)).status, 200);
  await runFile('python3', [helper, 'delete', page.id], { env });
  for (const path of [`/api/pages/${page.id}`, `/p/${page.id}`, `/p/${page.id}/source.md`, new URL(asset.url).pathname]) {
    assert.equal((await f.request(path)).status, 404);
  }
  assert.equal((await f.request(`/api/pages/${other.id}`)).status, 200);
  await assert.rejects(runFile('python3', [helper, 'delete', page.id], { env }),
    (error) => error.code === 1 && /HTTP 404/.test(error.stderr));
});

test('authored HTML cannot inject scripts, handlers, unsafe links, or document chrome', async (t) => {
  const f = await fixture(t);
  const page = await f.create('<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n<a href="javascript:alert(3)">bad</a>\n\n<div id="theme-toggle" class="site-header">spoof</div>');
  const html = await (await f.request(`/p/${page.id}`)).text();
  assert.doesNotMatch(html, /<script>alert|onerror=|javascript:alert/);
  assert.doesNotMatch(html, /<div id="theme-toggle"|<div[^>]*class="site-header"/);
});

test('ownership follows the key and group changes never grant cross-account access', async (t) => {
  const f = await fixture(t);
  const json = (path, method, body, key = f.key) => f.request(path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
  const input = { title: 'Grouped', markdown: 'Text' };
  for (const description of [undefined, '', '   ']) {
    assert.equal((await json('/api/pages', 'POST', { ...input, description })).status, 400);
  }
  input.description = 'A short summary';
  const group = await (await json('/api/groups', 'POST', { name: 'Work' })).json();
  const page = await (await json('/api/pages', 'POST', { ...input, groupId: group.id, owner: 'bob' })).json();
  assert.equal(page.owner, 'alice');
  assert.equal(page.groupId, group.id);
  const path = `/api/pages/${page.id}`;
  assert.equal((await (await json(path, 'PUT', input)).json()).groupId, group.id);
  assert.equal((await (await json(path, 'PATCH', { groupId: null })).json()).groupId, null);
  assert.equal((await (await json(path, 'PATCH', { groupId: group.id })).json()).groupId, group.id);
  const headers = { Authorization: `Bearer ${f.otherKey}` };
  assert.deepEqual((await (await f.request('/api/pages', { headers })).json()).pages, []);
  assert.equal((await json('/api/pages', 'POST', { ...input, groupId: group.id }, f.otherKey)).status, 400);
  for (const [method, suffix] of [['GET', ''], ['PUT', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/assets'], ['DELETE', '/assets/example']]) {
    assert.equal((await f.request(path + suffix, { method, headers })).status, 404);
  }
  assert.equal((await f.request('/library', { headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.request('/admin')).status, 404);
});

test('library requires a valid login; account keys work only until revoked', async (t) => {
  const f = await fixture(t);
  await f.create();
  const basic = (password) => ({ Authorization: `Basic ${Buffer.from(`bob:${password}`).toString('base64')}` });
  assert.equal((await f.request('/library', { headers: basic('wrong') })).status, 401);
  const headers = basic('test-password');
  const library = await f.request('/library', { headers });
  assert.equal(library.status, 200);
  assert.match(await library.text(), /System findings/);
  const account = await (await f.request('/account', { headers })).text();
  const csrf = account.match(/name="csrf" value="([^"]+)"/)[1];
  const post = (path, token) => f.request(path, { method: 'POST', headers, body: new URLSearchParams({ csrf: token }), redirect: 'manual' });
  assert.equal((await post('/account/keys', 'invalid')).status, 403);
  const issued = await post('/account/keys', csrf);
  assert.equal(issued.status, 201);
  const key = (await issued.text()).match(/<code>([A-Za-z0-9_-]{43})<\/code>/)[1];
  const bearer = { Authorization: `Bearer ${key}` };
  assert.deepEqual((await (await f.request('/api/pages', { headers: bearer })).json()).pages, []);
  const refreshed = await (await f.request('/account', { headers })).text();
  assert.ok(!refreshed.includes(key));
  const keys = Array.from(refreshed.matchAll(/action="(\/account\/keys\/[^"]+\/revoke)"/g), m => m[1]);
  // Both Bob's fixture key and newly issued key belong to Bob.
  for (const path of keys) assert.equal((await post(path, csrf)).status, 303);
  assert.equal((await f.request('/api/pages', { headers: bearer })).status, 401);
  assert.equal((await f.request('/api/pages')).status, 200);
});

test('admin requires separate credentials and confirmation token before cascading deletion', async (t) => {
  const password = 'test-admin-password-with-entropy';
  const f = await fixture(t, { adminPassword: password });
  const page = await f.create();
  const other = await f.create();
  const asset = await (await f.upload(page, 'delete with page')).json();
  assert.equal((await f.request('/admin')).status, 401);
  assert.equal((await f.request('/admin', { headers: { Authorization: `Basic ${Buffer.from(`wrong:${password}`).toString('base64')}` } })).status, 401);
  const headers = { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` };
  const dashboard = await f.request('/admin', { headers });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), new RegExp(page.id));
  assert.equal((await f.request('/api/pages', { headers })).status, 401);
  const path = `/admin/pages/${page.id}/delete`;
  const confirmation = await f.request(path, { headers });
  const token = (await confirmation.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const submit = (body, extra = {}) => f.request(path, { method: 'POST', redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', ...extra }, body });
  assert.equal((await submit('csrf=wrong')).status, 403);
  assert.equal((await submit(`csrf=${token}`, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.request(`/api/pages/${page.id}`)).status, 200);
  const deleted = await submit(`csrf=${token}`);
  assert.equal(deleted.status, 303);
  assert.equal(deleted.headers.get('location'), '/admin');
  for (const path of [`/p/${page.id}`, `/p/${page.id}/source.md`, new URL(asset.url).pathname]) {
    assert.equal((await f.request(path)).status, 404);
  }
  assert.equal((await f.request(`/api/pages/${other.id}`)).status, 200);
});
