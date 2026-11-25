# Pages: instructions for LLMs

Pages publishes Markdown as shareable HTML with code highlighting, tables, Mermaid, images, and downloadable attachments. It is experimental software for trusted local homelabs, not a production-hardened or multi-tenant service. Check the intended audience before publishing.

## Discover and use the existing clients

- Read this document at `/llms.txt` or rendered at `/docs`.
- Read the authoritative [API reference](/docs/api.md) for all fields, errors, limits, and recovery semantics; humans can use the [rendered reference](/docs/api).
- Read [OpenAPI 3.1](/openapi.json) for machine-readable operations and schemas.
- Download the complete [Python library](/sdk/pages.py) or [JavaScript ES module](/sdk/pages.mjs). **Use these libraries; do not reinvent the HTTP client.** They implement the page, group, and attachment APIs and multi-step publication without third-party dependencies.

Set `PAGES_URL` to the HTTP(S) service origin, for example `https://pages.example.com` (no path). The examples use that environment variable; the returned public URLs may use a different origin configured by the operator.

**Use a personal bearer key for every API operation.** The user creates and revokes keys at `/account` with their browser login. Read `PAGES_API_KEY` from private client configuration/environment, never chat or Markdown. Each key acts as its owner and can manage only that user's pages, attachments and groups. The signed-in `/library` table lists **everyone's** documents and summaries. Anyone holding a public HTML, source, or attachment link can read it without a key. Groups do not restrict readers. `/admin` is a separate browser dashboard.

Use HTTPS when credentials cross a network. Do not print secret environment values or enable shell tracing. A reverse proxy may add separate authentication that these clients do not configure.

## Python quick start

Requires Python 3.8 or newer. Download once into your working/tool directory (not into a published attachment):

```sh
export PAGES_URL=https://pages.example.com
curl --fail --show-error --silent "$PAGES_URL/sdk/pages.py" --output pages.py
```

From that directory:

```python
import os
from pathlib import Path
from pages import Client, PagesError

client = Client(os.environ['PAGES_URL'], os.environ['PAGES_API_KEY'])
try:
    page = client.publish(
        title='Incident review',
        description='Evidence and remediation.',
        markdown=Path('report.md').read_text(encoding='utf-8'),
        assets=['chart.png', 'measurements.csv'],
    )
    print(page['id'], page['url'])  # Retain these for later update/recovery.
except PagesError as error:
    print('Publication failed:', error.status, error.page_id, error.recovery_url)
    raise  # Inspect persisted state before retrying.
```

`report.md` can contain `![Chart](asset:chart.png)` and `[Download measurements](asset:measurements.csv)`. Basenames must identify supplied assets unambiguously. For a report without attachments, omit `assets`. `markdown` is text, not a file path.

All Python methods:

```python
listing = client.list()                         # Only this user's documents.
groups = client.list_groups()['groups']         # Each group has an id and name.
group = next((g for g in groups if g['name'] == 'Reviews'), None) or client.create_group('Reviews')
page = client.create('Incident review', '# Findings', description='What caused the outage.', group_id=group['id'])
page_id = page['id']
page = client.get(page_id)                      # Full page, Markdown, assets.
page = client.update(page_id, 'Incident review', '# Resolution', description='How the outage was resolved.')
page = client.set_group(page_id, None)          # Ungroup; pass a group ID to move.
asset = client.upload(page_id, 'appendix.pdf')   # Does not rewrite Markdown.
client.delete_asset(page_id, asset['id'])
# Replace via the full publication workflow; existing assets remain:
page = client.publish('Incident review', markdown, description='Evidence and remediation.', page_id=page_id)
client.delete(page_id)                          # Includes all attachments.
```

`Client(base_url, api_key, *, timeout=30)` accepts a timeout in seconds. Successful deletes return `None`. `PagesError.status` is the HTTP status or `None`; partial-publication recovery fields are `page_id` and `recovery_url`.

## JavaScript quick start

Requires Node.js 24 or newer. Download the Node.js ES module beside your script:

```sh
export PAGES_URL=https://pages.example.com
curl --fail --show-error --silent "$PAGES_URL/sdk/pages.mjs" --output pages.mjs
```

```javascript
import { readFile } from 'node:fs/promises';
import { Client, PagesError } from './pages.mjs';

const client = new Client(process.env.PAGES_URL, process.env.PAGES_API_KEY);
try {
  const page = await client.publish({
    title: 'Incident review',
    description: 'Evidence and remediation.',
    markdown: await readFile('report.md', 'utf8'),
    assets: ['chart.png', 'measurements.csv'],
  });
  console.log(page.id, page.url); // Retain these for later update/recovery.
} catch (error) {
  if (error instanceof PagesError) {
    console.error('Publication failed:', error.status, error.pageId, error.recoveryUrl);
  }
  throw error;
}
```

All JavaScript methods are asynchronous:

```javascript
const listing = await client.list(); // Only this user's documents.
const {groups} = await client.listGroups();
const group = groups.find(g => g.name === 'Reviews') ?? await client.createGroup('Reviews');
let page = await client.create({title: 'Incident review', markdown: '# Findings', description: 'What caused the outage.', groupId: group.id});
const pageId = page.id;
page = await client.get(pageId);
page = await client.update(pageId, {title: 'Incident review', markdown: '# Resolution', description: 'How the outage was resolved.'});
page = await client.setGroup(pageId, null); // Ungroup; pass a group ID to move.
const asset = await client.upload(pageId, 'appendix.pdf');
await client.deleteAsset(pageId, asset.id);
page = await client.publish({title: 'Incident review', markdown, description: 'Evidence and remediation.', pageId});
await client.delete(pageId);
```

`new Client(baseUrl, apiKey, {timeoutMs: 30000})` accepts a timeout in milliseconds. Successful deletes return `null`. `PagesError.status` is the HTTP status or `null`; partial-publication recovery fields are `pageId` and `recoveryUrl`.

## Publish safely

1. Use Markdown rather than executable HTML. Raw HTML is sanitized; scripts, iframes, and arbitrary CSS are unsupported. Mermaid fenced blocks, tables, and code blocks are supported.
2. Supply local files to `publish` and refer to them with `asset:basename`. The library substitutes each asset's returned `url`; non-image files download at that URL. Only signature-recognized PNG/JPEG/GIF/WebP display inline. To force an image download, use its returned `downloadUrl` when writing Markdown manually. HTML, SVG, PDF, and other files download. Keep credentials and private files out of attachments.
3. Save returned page IDs, URLs, and asset metadata. `get` returns persisted Markdown and assets; `list` returns metadata, ordered newest-updated first, with no pagination.
4. Supply title, Markdown and a nonblank summary (`description`) on every create or content replacement. Existing attachments remain. Omit the group on update to retain it, or pass a group ID or null to assign or clear it. To change only the group use `set_group`/`setGroup`. Reuse persisted asset URLs instead of uploading the same files again. Standalone upload/delete never rewrites Markdown.
5. Inspect persisted Markdown/assets and, when tools allow, open the **returned** public URL to check rendering, images, diagrams, and downloads. Public verification must not send the API key. Report only checks actually performed.
6. Delete only content the user intended to remove. Deleting a page cascades to all attachments and breaks its public links; it cannot revoke saved copies.

Limits: title ≤200 UTF-16 code units and nonblank; trimmed description 1–500; Markdown ≤1 MiB UTF-8; JSON body ≤1100 KiB including escaping; one file per upload, default ≤25 MiB (operator-configurable). There is no total storage quota, conditional update, or multi-request transaction. Keys issued by the same account share access. Writers are last-write-wins.

### Recover partial or ambiguous writes

The clients validate local assets/references before publication, reject redirects, and **never automatically retry**. Publication still spans multiple requests: create/replace, uploads, and final Markdown replacement can fail independently. Existing pages and successful uploads are retained on failure. Do not assume an error means nothing changed.

- Use the error's known page ID/recovery URL, then `get` to inspect source and assets.
- If create succeeded but its response was lost, `list` and inspect the uniquely intended page before creating again.
- If an upload response was lost, inspect the asset list before uploading again; uploads are not deduplicated.
- Resume against the existing page and reuse returned asset URLs. Check current state after an ambiguous update/delete.
- Never blindly retry writes or delete unrelated documents to clean up.

## Optional agent-host integration

No native plugin or hosted AI provider is required. A tool-capable agent can load these instructions and import a downloaded library. A skill/plugin does not grant filesystem or network permissions; use the actual host's documented discovery mechanism rather than assuming one universal install path.

This repository includes the omp workflow in `skills/publish-pages/`. To transfer it to an agent host, `scripts/package-skill.py` builds a private installer from the client's `PAGES_URL` and personal `PAGES_API_KEY` environment variables. Follow the repository README for installation, credential storage and rotation. Never publish or commit the installer.
