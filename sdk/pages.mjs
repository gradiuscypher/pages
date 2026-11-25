/**
 * Dependency-free Pages client for Node.js 24 (save as pages.mjs).
 *
 * import { Client, PagesError } from './pages.mjs';
 * const client = new Client('https://pages.example.com', process.env.PAGES_API_KEY);
 * const page = await client.publish({ title: 'Report', description: 'Quarterly trends',
 *   markdown: '![Chart](asset:chart.png)', assets: ['./chart.png'] });
 *
 * new Client(baseUrl, apiKey, { timeoutMs = 30000 } = {})
 *   Supply the API origin and a personal bearer key from /account.
 * All methods are async and return server JSON objects (deletes return null):
 *   list()
 *   get(pageId)
 *   listGroups()
 *   createGroup(name)
 *   setGroup(pageId, groupId) // null removes membership
 *   create({ title, markdown, description, groupId? })
 *   update(pageId, { title, markdown, description, groupId? })
 *   delete(pageId)
 *   upload(pageId, path)                               // one local file
 *   deleteAsset(pageId, assetId)
 *   publish({ title, markdown, description, groupId?, assets = [], pageId = null })
 * Description is a 1–500 character summary after trimming. Omit groupId to
 * preserve membership when updating an existing page; null clears it.
 *
 * publish takes Markdown CONTENT, not a filename. It preflights local files and
 * asset:basename references, creates/replaces a page, uploads all supplied files,
 * then saves Markdown with references replaced by returned URLs. Percent-encode
 * spaces/delimiters in references. Existing assets remain. Publication is not
 * atomic: PagesError.pageId/recoveryUrl identify partial work when known. Inspect
 * get/list before retrying uncertain writes. PagesError.status is HTTP or null.
 * Redirects and retries are never used. No requests/credentials are sent to public
 * page/asset URLs, which may use a different origin. Prefer HTTPS.
 */

import { access, stat } from 'node:fs/promises';
import { constants, openAsBlob } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

const assetReference = /asset:([^\s<>"'`()\[\]{}]+)/g;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PagesError extends Error {
  constructor(message, { status = null, pageId = null, recoveryUrl = null } = {}) {
    super(message);
    this.name = 'PagesError';
    this.status = status;
    this.pageId = pageId;
    this.recoveryUrl = recoveryUrl;
  }
}

function httpUrl(value, label, origin = false) {
  try {
    if (typeof value !== 'string' || !value || /[\s\x00-\x1f\x7f\\]/.test(value)) throw new Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new Error();
    if (origin && (url.pathname !== '/' || url.search || value.includes('?') || value.includes('#'))) throw new Error();
    return origin ? url.origin : value;
  } catch {
    throw new PagesError(`${label} must be an absolute HTTP(S) ${origin ? 'origin' : 'URL'} without credentials or fragment`);
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new PagesError('Page and asset IDs must be UUIDs');
  return value.toLowerCase();
}

function groupValue(groupId) {
  if (groupId !== null && (typeof groupId !== 'string' || !groupId.trim())) throw new PagesError('Expected a group ID or null');
  return groupId;
}

function documentInput({ title, markdown, description, groupId } = {}) {
  if (typeof title !== 'string' || !title.trim()) throw new PagesError('Title must be a nonempty string');
  if (typeof markdown !== 'string') throw new PagesError('Markdown must be a string');
  const summary = typeof description === 'string' ? description.trim() : '';
  if (!/^[\s\S]{1,500}$/u.test(summary)) {
    throw new PagesError('Description must be a summary of 1–500 characters');
  }
  const payload = { title, markdown, description: summary };
  if (groupId !== undefined) payload.groupId = groupValue(groupId);
  return payload;
}

async function prepareAssets(paths) {
  if (!Array.isArray(paths)) throw new PagesError('Assets must be an array of local file paths');
  const prepared = new Map();
  for (const value of paths) {
    if (typeof value !== 'string' || !value) throw new PagesError('Assets must be local file paths');
    const path = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
    const name = basename(path);
    if (!name || /[\x00-\x1f\x7f]/.test(name)) throw new PagesError('Asset basenames must not contain control characters');
    if (prepared.has(name)) throw new PagesError(`Duplicate asset basename ${JSON.stringify(name)}; rename files before publishing`);
    try {
      if (!(await stat(path)).isFile()) throw new Error();
      await access(path, constants.R_OK);
    } catch {
      throw new PagesError(`Cannot read regular asset file: ${path}`);
    }
    prepared.set(name, path);
  }
  return prepared;
}

export class Client {
  constructor(baseUrl, apiKey, { timeoutMs = 30000 } = {}) {
    this.baseUrl = httpUrl(baseUrl, 'Pages URL', true);
    if (typeof apiKey !== 'string' || !apiKey || /[^\x21-\x7e]/.test(apiKey)) throw new PagesError('A personal API key from /account is required (printable ASCII without whitespace)');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new PagesError('timeoutMs must be a positive integer no greater than 2147483647');
    this.#apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  #apiKey;

  async #request(method, route, { payload, body } = {}) {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${this.#apiKey}` };
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
    }
    let response;
    let text;
    try {
      response = await fetch(this.baseUrl + route, {
        method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new PagesError(`${method} ${route}: HTTP ${response.status}`, { status: response.status });
      }
      if (response.status === 204) return null;
      text = await response.text();
    } catch (error) {
      if (error instanceof PagesError) throw error;
      throw new PagesError(`${method} ${route}: network failure or timeout; server may have processed the request`);
    }
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new PagesError(`${method} ${route}: invalid JSON; request may have succeeded`);
    }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new PagesError(`${method} ${route}: expected a JSON object; request may have succeeded`);
    }
    return result;
  }

  async list() {
    return this.#request('GET', '/api/pages');
  }

  async listGroups() {
    return this.#request('GET', '/api/groups');
  }

  async createGroup(name) {
    if (typeof name !== 'string' || !name.trim()) throw new PagesError('Group name must be a nonempty string');
    return this.#request('POST', '/api/groups', { payload: { name: name.trim() } });
  }

  async setGroup(pageId, groupId) {
    return this.#request('PATCH', `/api/pages/${identifier(pageId)}`, { payload: { groupId: groupValue(groupId) } });
  }

  async get(pageId) {
    return this.#request('GET', `/api/pages/${identifier(pageId)}`);
  }

  async create(document) {
    return this.#request('POST', '/api/pages', { payload: documentInput(document) });
  }

  async update(pageId, document) {
    return this.#request('PUT', `/api/pages/${identifier(pageId)}`, { payload: documentInput(document) });
  }

  async delete(pageId) {
    return this.#request('DELETE', `/api/pages/${identifier(pageId)}`);
  }

  async deleteAsset(pageId, assetId) {
    return this.#request('DELETE', `/api/pages/${identifier(pageId)}/assets/${identifier(assetId)}`);
  }

  async upload(pageId, path) {
    const id = identifier(pageId);
    const [name, preparedPath] = (await prepareAssets([path])).entries().next().value;
    let blob;
    try {
      blob = await openAsBlob(preparedPath, { type: 'application/octet-stream' });
    } catch {
      throw new PagesError(`Cannot read asset: ${preparedPath}`);
    }
    const body = new FormData();
    body.append('file', blob, name);
    const result = await this.#request('POST', `/api/pages/${id}/assets`, { body });
    httpUrl(result.url, 'Asset URL');
    httpUrl(result.downloadUrl, 'Asset download URL');
    return result;
  }

  async publish({ title, markdown, description, groupId, assets = [], pageId = null } = {}) {
    const payload = documentInput({ title, markdown, description, groupId });
    let id = pageId === null ? null : identifier(pageId);
    const prepared = await prepareAssets(assets);
    const references = new Map();
    for (const match of markdown.matchAll(assetReference)) {
      const token = match[1];
      let name;
      try {
        name = decodeURIComponent(token);
      } catch {
        throw new PagesError(`Invalid percent-encoded asset reference: ${token}`);
      }
      if (!prepared.has(name)) throw new PagesError(`No asset supplied for asset:${token}`);
      references.set(token, name);
    }
    let recoveryUrl = null;
    try {
      const current = id ? await this.get(id) : await this.create(payload);
      // Retain the ID even when the server's public URL is malformed.
      id = identifier(current.id);
      recoveryUrl = httpUrl(current.url, 'Returned page URL');
      const uploaded = new Map();
      for (const [name, path] of prepared) uploaded.set(name, (await this.upload(id, path)).url);
      payload.markdown = markdown.replace(assetReference, (_, token) => uploaded.get(references.get(token)));
      const result = await this.update(id, payload);
      identifier(result.id);
      httpUrl(result.url, 'Returned page URL');
      return result;
    } catch (error) {
      let message = error instanceof PagesError ? error.message : 'Publication interrupted';
      if (id) {
        message += `\nPartial publication; recovery page ID: ${id}`;
        if (recoveryUrl) message += `\nRecovery URL: ${recoveryUrl}`;
        message += '\nInspect get before retrying; existing attachments are retained.';
      } else {
        message += '\nIf creation reached the server, use list before retrying.';
      }
      throw new PagesError(message, { status: error instanceof PagesError ? error.status : null, pageId: id, recoveryUrl });
    }
  }
}
