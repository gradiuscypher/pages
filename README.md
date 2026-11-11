# Pages

> [!WARNING]
> Vibecoded, experimental software for trusted local homelabs only.
> Do not run this code in production or expose it directly to the Internet.

An artifact publisher for agents. Publish Markdown as readable HTML pages with light/dark mode, highlighted code, tables, Mermaid diagrams, images, and downloadable attachments. No editor, account system, CDN, or external database.

The palette follows [grds.io](https://grds.io/). Typography uses locally installed Berkeley Mono when available and bundled IBM Plex Mono otherwise. Berkeley Mono font files are not distributed.

## Run

Requires Node.js 24 or newer, npm, and Python 3 for the optional agent helper. Docker Compose is an alternative to installing Node on the host.

```sh
git clone https://github.com/gradiuscypher/pages.git
cd pages
npm ci
npm run build
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
# Privately set PAGES_API_KEY in .env to that generated value; never paste it into chat.
# Set PUBLIC_URL to the origin readers and agents will use.
npm start
```

Open `http://localhost:3000` for the formatting showcase. The landing page does not list published documents. `GET /healthz` is the health check. Build again after editing files in `web/`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAGES_API_KEY` | Required | Bearer key, at least 24 characters; use a random 32-byte key |
| `PUBLIC_URL` | `http://localhost:3000` | Canonical HTTP(S) origin, without a path; used in returned links |
| `HOST` | `127.0.0.1` | Listening address |
| `PORT` | `3000` | Listening port; also changes the default public URL |
| `DATA_DIR` | `./data` | Directory containing `pages.sqlite` and its WAL files |
| `MAX_UPLOAD_MB` | `25` | Maximum bytes per attachment, in MiB |
| `PAGES_BIND_ADDRESS` | `127.0.0.1` | Compose-only host address; set the LAN IP to expose Pages there |
| `PAGES_PORT` | `3000` | Compose-only published host port; reflect it in `PUBLIC_URL` |

`npm start` reads `.env`; the container receives variables from Compose. Keep `.env` private (`chmod 600 .env`). Rotate the publishing key by changing it and restarting; existing page links remain valid.

### Container

With `.env` configured:

```sh
docker compose up --build -d
```

Use `sudo docker ...` when your account does not have Docker socket access. Membership in the `docker` group grants root-equivalent host privileges; it is not required for this deployment.

Compose binds to `PAGES_BIND_ADDRESS:PAGES_PORT` and stores the database in the `pages-data` volume. The default is loopback. For LAN access, set `PAGES_BIND_ADDRESS` to the host's LAN IP and `PUBLIC_URL` to `http://LAN_IP:PAGES_PORT`, then recreate with `docker compose up --build -d --wait`. This publishes only on that address, not every host interface; it does not enforce a source-subnet firewall. Keep the LAN address stable with a static assignment or DHCP reservation. The container restarts unless explicitly stopped and exposes a Docker health check.

For HTTPS, put your internal reverse proxy in front of the published port and set `PUBLIC_URL` to its HTTPS origin. If running Node directly behind a proxy, leave `HOST=127.0.0.1`. Set request-body limits at the proxy above `MAX_UPLOAD_MB` plus multipart overhead. Container port 3000 listens on all interfaces inside the container. HTTP sends the bearer key unencrypted; use it only on a trusted LAN/VPN.

### Reader access and trust

**The key protects all `/api` operations, including listing and reading source through the API. Public page links, source downloads, and attachment links require no key.** Their UUIDs are unguessable, not a substitute for reader authentication. Anyone holding a link can read or forward it. There is no public document index.

Deploy on a trusted private homelab network/VPN, not in production or on the public Internet. For confidential artifacts, enforce reader authentication at an internal reverse proxy. Use HTTPS whenever the key crosses a network. The publishing key grants full control of all documents; keep it in agent environment/secrets, not prompts or committed files.

Raw HTML in Markdown is sanitized; executable HTML, JavaScript, embedded iframes, and arbitrary CSS are not supported. Upload standalone HTML reports as downloads, or express the report using Markdown, tables, images, and Mermaid. Only signature-recognized PNG, JPEG, GIF, and WebP files display inline. SVG, HTML, PDFs, and all other uploads are forced downloads with a sandbox policy. Remote HTTPS images can be embedded and contact their host when readers open the page; use uploaded images for self-contained reports.

Attachments are stored as database BLOBs. Uploads are buffered in memory up to the per-file limit. This is a small internal publisher, not a multi-tenant file store: there is no total storage quota or per-agent access isolation. Page updates are full replacements; concurrent writers are last-write-wins.

## AI agents

See [agent setup and LLM-guided skill/plugin integration](docs/agents.md) for installing the bundled workflow, connecting other agent hosts, and a setup prompt you can give your own LLM. There is no required hosted AI service or model-specific native plugin.

### Publish with the omp skill

Build a single-file installer using the server's private `.env`:

```sh
python3 scripts/package-skill.py
```

This creates `.local/install-pages-skill.py` with mode `0600`. **It contains the real publishing key.** `.env` and `.local/` are excluded from Git and the Docker build context. Transfer the installer with SCP/SFTP to the homelab VM, then run it as the user who runs omp:

```sh
chmod 600 install-pages-skill.py
python3 install-pages-skill.py
python3 ~/.agents/skills/publish-pages/scripts/pages.py list
rm install-pages-skill.py
```

The installer writes the skill to `~/.agents/skills/publish-pages/` and credentials to `~/.config/grds-pages/client.json` (or `$XDG_CONFIG_HOME/grds-pages/client.json`) with mode `0600`. Start a new omp session to discover the skill. Python 3 is the only dependency. No repository checkout, shell startup changes, or exported secrets are needed. An unchanged installer can be rerun safely; use `--replace` explicitly when updating existing differing files.

`PAGES_URL` and `PAGES_API_KEY` override corresponding stored client settings. For secret-manager deployment instead, copy `skills/publish-pages/` to `~/.agents/skills/` and supply both environment variables. Read `skills/publish-pages/SKILL.md` for the publishing workflow and the helper's `--help` for commands. After rotating the server key or changing its public URL, regenerate the installer and update client hosts.

Delete a page and all its attachments with `python3 ~/.agents/skills/publish-pages/scripts/pages.py delete PAGE_UUID`. Success prints the deleted UUID; missing pages fail with HTTP 404. Deletion removes public page, source, and attachment access, but cannot revoke saved copies. To distribute updated tooling to installed agents, regenerate the installer and run it on each client with `--replace`.

## HTTP interface

Every `/api` request uses `Authorization: Bearer <PAGES_API_KEY>`. JSON writes use `Content-Type: application/json`. Errors use `{ "error": "message" }`; invalid input is 400, unauthorized is 401, missing resources 404, and oversized bodies/uploads 413.

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/api/pages` | Create; 201 and full page JSON |
| `GET` | `/api/pages` | `{ "pages": [...] }`, newest updated first; metadata only |
| `GET` | `/api/pages/:id` | Full page JSON with Markdown and attachments |
| `PUT` | `/api/pages/:id` | Replace title, description, Markdown; attachments retained |
| `DELETE` | `/api/pages/:id` | Delete page and its attachments; 204 |
| `POST` | `/api/pages/:id/assets` | Upload one multipart `file`; 201 and asset JSON |
| `DELETE` | `/api/pages/:id/assets/:assetId` | Delete an attachment owned by this page; 204 |

Create/update body:

```json
{
  "title": "Incident review",
  "description": "Evidence, impact, and remediation.",
  "markdown": "## Findings\n\nNo customer data was exposed.\n\n```mermaid\nflowchart LR\n  Alert --> Investigate --> Resolve\n```"
}
```

`title` is required (1–200 characters), `description` is optional (up to 500), `markdown` is required (up to 1 MiB; may be empty). Omitting description on update clears it. Page JSON includes `id`, `title`, `description`, `markdown`, ISO `createdAt`/`updatedAt`, absolute `url`, and `assets`. Listing omits Markdown and assets.

Asset JSON includes `id`, `pageId`, `name`, detected `mime`, byte `size`, absolute `url`, and `downloadUrl`. Upload after creating the page, then update Markdown to reference the returned URL:

```md
![Latency comparison](https://pages.internal.example/assets/ASSET_ID/latency.png)
[Download full report](https://pages.internal.example/assets/OTHER_ID/report.html?download=1)
```

Public read paths: `/p/:id` for HTML, `/p/:id/source.md` for a Markdown download, `/assets/:id/:name` for an attachment (`?download=1` forces download). The server returns `no-store`, `noindex`, a restrictive content security policy, and no referrer headers. These do not revoke copies readers have already saved.

## Operations

All durable state, including attachments, is in `DATA_DIR`. Back up SQLite with its online backup mechanism (for example `sqlite3 data/pages.sqlite '.backup pages-backup.sqlite'`), or stop the service before copying the database. Do not copy just the main file while the service is writing: committed changes may be in the WAL. Restore with the service stopped. Keep the database and backups private.

`npm test` covers authentication, persistence across reopening, updates, unsafe authored HTML, attachment handling, upload limits, ownership, and cascading deletion. The browser bundle and fonts are built locally; published pages do not need a CDN.

## Contributing and publishing safely

This repository is the source of truth for Pages. Make contributions here and keep setup, API, and agent documentation aligned with changes.

Before committing, inspect the staged files and diff for publishing keys, private hostnames/IPs (including LAN addresses), user paths, and generated artifacts. Keep `.env` variants, `.local/` credential installers, client configurations, databases/WALs, backups, and uploaded artifacts private. `.env.example` contains only empty credentials and loopback defaults; use reserved example domains in documentation. Git ignores are a safeguard, not a secret scanner: review new files and scan the staged snapshot and any history you plan to push. If a credential leaks, rotate it immediately; deleting a file does not remove it from Git history.

## License

[MIT](LICENSE). Third-party packages and bundled fonts retain their respective licenses.
