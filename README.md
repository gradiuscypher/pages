# Pages

> [!WARNING]
> Vibecoded, experimental software for trusted local homelabs only.
> Do not run this code in production or expose it directly to the Internet.

An artifact publisher for agents. Publish Markdown as readable HTML pages with light/dark mode, highlighted code, tables, Mermaid diagrams, images, and downloadable attachments. Each page belongs to a local user and can belong to one of that user's groups. No editor, CDN, or external database.

Reading text defaults to 18px. The **Text size** selector in the top-right corner remembers your choice in this browser. On desktop, Pages reserves wider margins and uses the extra right-hand space for the sticky table of contents. At viewport widths of 960px or less, the table of contents moves above the article.

The table of contents highlights the section being read and keeps its link in view as you move between sections. You can scroll the list independently without moving the article.

To share a section, copy the `#` link beside its Markdown heading. These links use the heading’s position, so inserting or removing an earlier heading changes the target of a saved link.

Choose **Export to HTML** on a published page, then open the downloaded `.html` file directly in a browser. It keeps the current theme and text size, rendered diagrams and their source, and downloadable attachments. Images that cannot be embedded (for example, when a remote host blocks copying) become labeled online links; the export status tells you how many. Ordinary web links still point to their original destinations.

The palette follows [grds.io](https://grds.io/). Typography uses locally installed Berkeley Mono when available and bundled IBM Plex Mono otherwise. Berkeley Mono font files are not distributed.

## Run

Requires Node.js 24 or newer and npm. Python 3 is needed only for Python clients and the optional agent helper. Docker Compose is an alternative to installing Node on the host.

```sh
git clone https://github.com/gradiuscypher/pages.git
cd pages
npm ci
npm run build
cp .env.example .env
chmod 600 .env
# Set PUBLIC_URL to the origin readers and agents will use.
# Optionally set a separate ADMIN_PASSWORD (at least 16 characters).
npm start
```

Open `http://localhost:3000` for the formatting showcase. The landing page does not list published documents. `GET /healthz` is the health check. Build again after editing files in `web/`.

### Provision accounts and publish

Create local accounts on the server, against the same `DATA_DIR` the service uses. `node scripts/create-user.js USERNAME` reads the password from standard input. Usernames are 1–64 ASCII letters, digits, underscores, periods, or hyphens. For example, in Bash:

```sh
read -rsp 'New account password: ' pages_password; printf '\n'
printf '%s\n' "$pages_password" | node --env-file=.env scripts/create-user.js alice
unset pages_password
```

For Compose, use `docker compose exec -T pages node scripts/create-user.js alice` in place of the `node` command above, so the account is created in the mounted database. Use a unique password and HTTPS for browser logins.

On upgrade, back up the database before starting the new version. Migration assigns existing documents to `gradius` and fills missing summaries; page IDs, public links, and attachments stay intact. Provision the `gradius` login to manage those documents. The old server-wide publishing key no longer works. Give each publishing client a personal key instead:

1. Open `/account` in a browser and sign in with your local username and password (HTTP Basic).
2. Generate a personal key, copy it into the client's secret store, and send it as `Authorization: Bearer <key>` on `/api` requests. The account page is also where you revoke keys and manage groups.
3. Publish a title, short summary (`description`), and Markdown. Choose one of your groups now or assign one later. Visit `/library` to browse the table of **all users'** documents and summaries; it requires an account.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Empty (admin disabled) | Separate dashboard password, at least 16 characters when set |
| `PUBLIC_URL` | `http://localhost:3000` | Canonical HTTP(S) origin, without a path; used in returned links |
| `HOST` | `127.0.0.1` | Listening address |
| `PORT` | `3000` | Listening port; also changes the default public URL |
| `DATA_DIR` | `./data` | Directory containing `pages.sqlite` and its WAL files |
| `MAX_UPLOAD_MB` | `25` | Maximum bytes per attachment, in MiB |
| `PAGES_BIND_ADDRESS` | `127.0.0.1` | Compose-only host address; set the LAN IP to expose Pages there |
| `PAGES_PORT` | `3000` | Compose-only published host port; reflect it in `PUBLIC_URL` |

`npm start` reads `.env`; the container receives variables from Compose. Keep `.env` private (`chmod 600 .env`). Rotate the admin password by changing it and restarting. Rotate a personal API key by generating its replacement, updating the client, and revoking the old key at `/account`; public links are unaffected.

### Container

With `.env` configured:

```sh
docker compose up --build -d
```

Use `sudo docker ...` when your account does not have Docker socket access. Membership in the `docker` group grants root-equivalent host privileges; it is not required for this deployment.

Compose binds to `PAGES_BIND_ADDRESS:PAGES_PORT` and stores the database in the `pages-data` volume. The default is loopback. For LAN access, set `PAGES_BIND_ADDRESS` to the host's LAN IP and `PUBLIC_URL` to `http://LAN_IP:PAGES_PORT`, then recreate with `docker compose up --build -d --wait`. This publishes only on that address, not every host interface; it does not enforce a source-subnet firewall. Keep the LAN address stable with a static assignment or DHCP reservation. The container restarts unless explicitly stopped and exposes a Docker health check.

For HTTPS, put your internal reverse proxy in front of the published port and set `PUBLIC_URL` to its HTTPS origin. If running Node directly behind a proxy, leave `HOST=127.0.0.1`. Set request-body limits at the proxy above `MAX_UPLOAD_MB` plus multipart overhead. Container port 3000 listens on all interfaces inside the container. Plain HTTP sends browser passwords and bearer keys unencrypted.

### Reader access and trust

Every API request requires a valid personal bearer key and acts as that user. The API lists and manages only the owner's pages, attachments, and groups. Two keys issued by the same user share that user's access. Groups organize pages; they are not access-control lists.

Anyone with a public page, Markdown source, or attachment link can read or forward it without signing in. Every account holder can discover documents via `/library`. Deploy on a trusted private homelab network/VPN, not on the public Internet. For confidential artifacts, enforce reader authentication at an internal reverse proxy. Keep keys in client secrets, not prompts or committed files.

Raw HTML in Markdown is sanitized; executable HTML, JavaScript, embedded iframes, and arbitrary CSS are not supported. Upload standalone HTML reports as downloads, or express the report using Markdown, tables, images, and Mermaid. Only signature-recognized PNG, JPEG, GIF, and WebP files display inline. SVG, HTML, PDFs, and all other uploads are forced downloads with a sandbox policy. Remote HTTPS images can be embedded and contact their host when readers open the page; use uploaded images for self-contained reports.

Attachments are stored as database BLOBs. Uploads are buffered in memory up to the per-file limit. There is no total storage quota. Page content updates are full replacements; concurrent writers are last-write-wins.

## AI agents

Start with the served [LLM instructions](/llms.txt) (also rendered at `/docs`), [API reference](docs/api.md) (rendered at `/docs/api`, raw at `/docs/api.md`), and [OpenAPI 3.1 document](docs/openapi.json) (served at `/openapi.json`). Download the complete Python client from `/sdk/pages.py` or JavaScript module from `/sdk/pages.mjs`; use these libraries rather than implementing another HTTP client. [Agent instructions](docs/agents.md) include copyable usage. There is no required hosted AI service or model-specific native plugin.

### Publish with the omp skill

The optional omp installer packages client credentials from the environment, not the server `.env`. Supply `PAGES_URL` (service origin) and `PAGES_API_KEY` (a personal key created at `/account`) through your secret manager, then run:

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

`PAGES_URL` and `PAGES_API_KEY` override corresponding stored client settings. For secret-manager deployment instead, copy `skills/publish-pages/` to `~/.agents/skills/` and supply both environment variables. Read `skills/publish-pages/SKILL.md` for the publishing workflow and the helper's `--help` for commands. After rotating that client's key or changing its public URL, regenerate the installer and update client hosts.

Delete a page and all its attachments with `python3 ~/.agents/skills/publish-pages/scripts/pages.py delete PAGE_UUID`. Success prints the deleted UUID; missing pages fail with HTTP 404. Deletion removes public page, source, and attachment access, but cannot revoke saved copies. To distribute updated tooling to installed agents, regenerate the installer and run it on each client with `--replace`.

## HTTP interface

The authoritative [API reference](docs/api.md) documents every API operation, request/response shape, limits, public reads, attachment workflow, and recovery from partial publication. It is rendered at `/docs/api` and served as Markdown at `/docs/api.md`; machine-readable OpenAPI is at `/openapi.json`.

## Admin dashboard

Set `ADMIN_PASSWORD` to a separate private password of at least 16 characters and restart to enable `/admin`. Without a password, `/admin` is disabled. Open it in a browser and use HTTP Basic authentication with username `admin` and the configured password.

The dashboard lets an administrator review published documents and delete pages with their attachments. Deletion is CSRF-protected and irreversible; it cannot revoke copies readers already downloaded. Dashboard credentials are separate from account logins and personal API keys. Use HTTPS for the browser login and keep this interface on the trusted network.

## Operations

All durable state, including attachments, is in `DATA_DIR`. Back up SQLite with its online backup mechanism (for example `sqlite3 data/pages.sqlite '.backup pages-backup.sqlite'`), or stop the service before copying the database. Do not copy just the main file while the service is writing: committed changes may be in the WAL. Restore with the service stopped. Keep the database and backups private.

`npm test` covers authentication, persistence across reopening, updates, unsafe authored HTML, attachment handling, upload limits, ownership, and cascading deletion. The browser bundle and fonts are built locally; published pages do not need a CDN.

## Contributing and publishing safely

This repository is the source of truth for Pages. Make contributions here and keep setup, API, and agent documentation aligned with changes.

Before committing, inspect the staged files and diff for publishing keys, private hostnames/IPs (including LAN addresses), user paths, and generated artifacts. Keep `.env` variants, `.local/` credential installers, client configurations, databases/WALs, backups, and uploaded artifacts private. `.env.example` contains only empty credentials and loopback defaults; use reserved example domains in documentation. Git ignores are a safeguard, not a secret scanner: review new files and scan the staged snapshot and any history you plan to push. If a credential leaks, rotate it immediately; deleting a file does not remove it from Git history.

## License

[MIT](LICENSE). Third-party packages and bundled fonts retain their respective licenses.
