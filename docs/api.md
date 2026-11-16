# Pages API reference

Base URL: the service origin, for example `https://pages.example.com`. All paths below are relative to it. Discover [agent instructions](/llms.txt), [rendered documentation](/docs), and [OpenAPI 3.1](/openapi.json). This reference is served at `/docs/api.md` and [rendered at `/docs/api`](/docs/api).

## Authentication and trust

The API is **open by default**: absent or empty server `PAGES_API_KEY` disables API authentication. When configured, **every `/api` request**, including list and get, requires exact `Authorization: Bearer <key>`. Missing/incorrect credentials return 401 with `WWW-Authenticate: Bearer`. There are no per-page scopes, owners, or separate read/write keys. Public reads and documentation do not require the API key. The optional `/admin` browser dashboard has separate HTTP Basic authentication; do not send its password as a Bearer key.

Use a trusted LAN/VPN and HTTPS. Open API access permits anyone who can reach it to list, read, modify, and delete all content. Public links are not reader authentication. Keep credentials out of Markdown, attachments, logs, and prompts.

## Client libraries

Download the complete, dependency-free Python 3.8+ client at [`/sdk/pages.py`](/sdk/pages.py) or the Node.js 24+ ES module at [`/sdk/pages.mjs`](/sdk/pages.mjs). Prefer these libraries to hand-written HTTP code. See [agent instructions](/llms.txt) for runnable download/import examples and publication with assets.

Python: `Client(base_url, api_key=None, *, timeout=30)` exposes `list()`, `get(page_id)`, `create(title, markdown, description='')`, `update(page_id, title, markdown, description='')`, `delete(page_id)`, `upload(page_id, path)`, `delete_asset(page_id, asset_id)`, and `publish(title, markdown, description='', assets=(), page_id=None)`.

JavaScript: `new Client(baseUrl, apiKey=null, {timeoutMs=30000}={})` exposes asynchronous `list()`, `get(pageId)`, `create({title, markdown, description=''})`, `update(pageId, {title, markdown, description=''})`, `delete(pageId)`, `upload(pageId, path)`, `deleteAsset(pageId, assetId)`, and `publish({title, markdown, description='', assets=[], pageId=null})`.

Responses are the JSON shapes below; deletes return Python `None` / JavaScript `null`. Both libraries reject redirects and do not automatically retry. `PagesError.status` is the HTTP status or null/None for a transport/local failure. Publication errors expose known recovery state as Python `page_id` / `recovery_url` or JavaScript `pageId` / `recoveryUrl`. Markdown arguments contain the document text, not a pathname.

## JSON shapes

Create and replace accept `Content-Type: application/json`:

```json
{"title":"Incident review","description":"Evidence and remediation.","markdown":"## Findings\n\nResolved."}
```

- `title`: required string, nonblank after trimming; maximum 200 JavaScript UTF-16 code units **before** trimming.
- `description`: optional string, default `""`, maximum 500 UTF-16 code units before trimming. Title and description are trimmed when stored.
- `markdown`: required string, may be empty, maximum 1,048,576 UTF-8 bytes. Stored unchanged.
- Unknown object properties are ignored. Arrays, null, missing required fields, and wrong types are invalid. JSON parser limit is `1100kb` (1,126,400 bytes), including JSON syntax/escaping. A document can fit the Markdown limit but exceed the JSON request limit.

A **PageSummary** contains exactly these fields (UUID and timestamps below are examples):

```json
{"id":"00000000-0000-4000-8000-000000000001","title":"Incident review","description":"Evidence and remediation.","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","url":"https://pages.example.com/p/00000000-0000-4000-8000-000000000001"}
```

A **Page** contains all PageSummary fields plus `markdown` (string) and `assets` (array of Asset objects; empty when none). An **Asset** has:

```json
{"id":"00000000-0000-4000-8000-000000000002","pageId":"00000000-0000-4000-8000-000000000001","name":"chart.png","mime":"image/png","size":1234,"url":"https://pages.example.com/assets/00000000-0000-4000-8000-000000000002/chart.png","downloadUrl":"https://pages.example.com/assets/00000000-0000-4000-8000-000000000002/chart.png?download=1"}
```

`size` is bytes; `mime` is signature-detected, not the supplied content type. URLs use the server's configured `PUBLIC_URL`, which can differ from the client connection origin. Use returned URLs rather than reconstructing names. Dates are UTC ISO 8601 strings; IDs are generated UUIDs. Assets are returned in upload order.

## API operations

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/pages` | None | 200 `{"pages":[PageSummary,...]}`; all pages, ordered `updatedAt` descending then ID ascending; no pagination/filtering |
| `POST /api/pages` | Document JSON above | 201 Page; `Location` is its public HTML URL |
| `GET /api/pages/{id}` | None | 200 Page |
| `PUT /api/pages/{id}` | Complete document JSON above | 200 Page; full replacement, not a patch; existing attachments retained; omitted description clears it |
| `DELETE /api/pages/{id}` | None | 204, empty body; deletes page and all its attachments |
| `POST /api/pages/{id}/assets` | `multipart/form-data` with exactly one file part named `file`, with filename; no other fields/parts | 201 Asset; `Location` is its public URL |
| `DELETE /api/pages/{id}/assets/{assetId}` | None | 204, empty body; asset must belong to this page |

Get/replace/delete/upload on a missing page returns 404. Deleting a missing asset or an asset belonging to another page returns 404. Repeating a successful delete therefore returns 404, not 204. There is no bulk operation, patch, search, version history, idempotency key, conditional update, or transaction spanning API requests. Concurrent updates are last-write-wins. Page creation/update and attachment add/remove update `updatedAt`; uploading/deleting an attachment does not rewrite Markdown. Asset deletion may leave broken Markdown links.

### Upload limits and rendering

Default maximum attachment size is 25 MiB (26,214,400 bytes); the operator can change `MAX_UPLOAD_MB`. Uploads are buffered in memory and stored as SQLite BLOBs. There is no total storage quota. Exactly one file is accepted; additional files, text fields, or unexpected file field names are rejected. Empty file content is allowed when a file part and valid filename are present.

The server strips directory components (including Windows separators), removes control characters, and truncates the filename to 180 UTF-16 code units. Empty names and `.`/`..` are invalid. Filenames need not be unique: uploads always create a new asset ID and never replace an existing asset.

Only PNG, JPEG, GIF, and WebP recognized by their signatures receive an image MIME type and can render inline. Everything else, including SVG, PDF, and HTML, receives `application/octet-stream` and downloads. Supplied MIME headers and extensions do not change this. Raw authored HTML is sanitized. JavaScript, iframes, and arbitrary CSS are unsupported. Remote HTTPS images may contact their host; prefer uploaded images for self-contained reports.

### Asset workflow and partial recovery

1. Create the page; immediately retain its returned ID and URL.
2. Upload each asset to that page; retain each returned Asset, including URLs.
3. Replace the page Markdown to embed images with `![Chart](<returned url>)` and downloads with `[Download](<returned downloadUrl>)`.
4. Get the page to inspect persisted source/assets; open its public URL to inspect rendering.

The downloadable clients' `publish` method performs this workflow and replaces `asset:basename` references with each uploaded asset's returned `url`. Non-image files download at that URL. When writing Markdown yourself, use `url` for images and `downloadUrl` to force downloads (including images). Standalone `upload` never changes Markdown. On update, retain and reuse existing URLs to avoid duplicate uploads.

Publication is **not atomic**. A later failure can leave a created page, some uploaded assets, or an earlier version of Markdown. Clients retain partial server state rather than deleting potentially useful content. Inspect the error's recovery ID/URL, then get the page and compare assets/source before resuming. If a create response was lost, list and inspect the uniquely intended document before creating again. If an upload response was lost, get the page's asset list before retrying: retrying may duplicate the upload. For ambiguous update/delete failures, read persisted state before retrying. Do not blindly retry writes; do not delete unrelated pages as cleanup. Deletion cannot revoke copies readers already saved.

## Public reads and discovery

These routes require no API credential, even when a key is configured:

| GET path | Success |
| --- | --- |
| `/` | 200 HTML formatting showcase; not a page index |
| `/healthz` | 200 JSON `{"status":"ok"}` |
| `/docs` | 200 rendered agent documentation |
| `/llms.txt` | 200 Markdown agent instructions |
| `/docs/api` | 200 rendered HTML API reference |
| `/docs/api.md` | 200 Markdown API reference |
| `/openapi.json` | 200 OpenAPI 3.1 JSON |
| `/sdk/pages.py` | 200 downloadable complete Python client |
| `/sdk/pages.mjs` | 200 downloadable complete JavaScript client |
| `/p/{id}` | 200 rendered HTML |
| `/p/{id}/source.md` | 200 original Markdown, attachment filename `{id}.md` |
| `/assets/{id}/{name}` | 200 bytes; filename must match stored name; inline only for supported images |

Append `?download=1` to an asset URL to force attachment disposition, including for images. Both public asset URL forms deliver identical bytes. Missing public pages/assets return 404 HTML, not the API JSON error shape. Asset responses have `Content-Security-Policy: default-src 'none'; sandbox`. Responses use `Cache-Control: no-store`, no-index headers, no-referrer policy, and a restrictive CSP; these do not enforce reader authentication or revoke saved copies. `/static/*` serves the application's built browser assets, not an upload API.

## Errors

API errors use JSON `{"error":"message"}`. Do not depend on message text as an error code.

| Status | Causes |
| --- | --- |
| 400 | Invalid document fields/JSON; malformed URI or multipart form; missing/invalid filename; missing file, extra multipart fields/parts/files, wrong file field |
| 401 | API key configured and Bearer value missing/incorrect |
| 404 | Page missing, asset missing/not owned by page, unknown API route |
| 413 | JSON body too large or file exceeds configured byte limit |
| 500 | Unexpected server failure |

Successful DELETE has no JSON body. Auth is checked before API body parsing. Existing-page lookup precedes page-specific handler validation. Network/proxy errors may have non-JSON bodies or no HTTP response; the libraries surface them as errors rather than pretending a write did not happen.
