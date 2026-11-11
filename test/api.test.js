import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

const key = 'test-key-with-at-least-24-characters';
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pages-test-'));
  const options = { apiKey: key, publicUrl: 'https://pages.internal', dataDir, maxUploadBytes: 1024 };
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
  for (const authorization of ['', 'Bearer wrong', `Basic ${key}`, `Bearer ${key}extra`]) {
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
    body: JSON.stringify({ title: 'Revised report', markdown: '## Updated\n\nNew evidence.' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).description, '');
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
  const env = { ...process.env, PAGES_URL: base, PAGES_API_KEY: key };
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
