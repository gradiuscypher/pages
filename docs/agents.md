# Set up Pages for your agent

> Vibecoded, experimental software for trusted local homelabs only. Do not run in production or expose directly to the Internet.

Use this guide to connect a tool-capable LLM to a Pages service. The canonical publishing workflow is [`skills/publish-pages/SKILL.md`](../skills/publish-pages/SKILL.md); its Python helper implements the API client. This repository supplies a skill and helper, **not a built-in plugin for every agent product**.

## 1. Clone and run the service

```sh
git clone https://github.com/gradiuscypher/pages.git
cd pages
```

Follow [README: Run](../README.md#run) for Node.js or Docker setup, environment variables, network binding, and reverse-proxy configuration. Complete that setup before installing a client. Python 3 is required on client hosts; the helper needs no Python packages. Confirm `/healthz` responds at the configured service origin.

**Trust boundary:** this is a small internal publisher, not a hardened or multi-tenant service. Keep it on a trusted LAN/VPN; use HTTPS when credentials cross a network. HTTP exposes the bearer key in transit. For confidential documents, enforce reader authentication at a network boundary or internal reverse proxy.

The single publishing key grants full control over **every** page and attachment, including list, read, update, and delete. There are no per-agent permissions, scoped keys, or reader accounts. Every `/api` operation requires the bearer key. Returned page URLs, `/p/UUID/source.md`, and returned attachment URLs require **no Pages key**. Unguessable links and an absent public index do not make content private. A reader-authenticating proxy is a separate access layer; its authentication may require additional client integration.

Complete this step when the service is reachable from the agent host, `PUBLIC_URL` points to the origin readers can reach, and the human has selected an appropriate audience. The client origin may differ from `PUBLIC_URL`; public-link verification must use the returned URLs.

## 2. Install for omp

On the service host, from the repository root with its private `.env` configured:

```sh
chmod 600 .env
python3 scripts/package-skill.py
```

This creates `.local/install-pages-skill.py` with mode `0600`. **The installer embeds the live publishing key**, not an encrypted secret. Transfer it using SCP/SFTP over your already configured SSH connection, or run it locally if the agent runs on this host. Keep both the generated original and any transferred copy private; never attach them to a page, paste them into chat, or commit them.

On the agent host, as the user who runs omp, in the directory containing the transferred installer:

```sh
chmod 600 install-pages-skill.py
python3 install-pages-skill.py
python3 ~/.agents/skills/publish-pages/scripts/pages.py list
rm install-pages-skill.py
```

For a same-host installation, run `python3 .local/install-pages-skill.py` from the repository instead; remove that generated installer after installation. The installer writes:

- Skill and helper: `~/.agents/skills/publish-pages/`.
- Private credentials: `~/.config/grds-pages/client.json`, or `$XDG_CONFIG_HOME/grds-pages/client.json`, mode `0600`.

Start a new omp session to reload skill discovery. No shell startup edits or secret exports are required. An identical installer can be rerun; differing installed files require an intentional `--replace`. After server-key rotation or a public-origin change, regenerate the installer and update clients with `--replace`. `PAGES_URL` and `PAGES_API_KEY`, if set, override the corresponding stored settings; remove stale overrides when using the installer configuration.

Complete this step when `list` succeeds without displaying credentials and the new omp session discovers `publish-pages`.

## 3. Use another tool-capable LLM

A skill is instructions plus local files; it does not grant shell, file, browser, or network permissions. Give the host the necessary tools and access to the service. Inspect that host's installed version and actual skill/plugin discovery mechanism before selecting an installation directory or format. Do not assume omp's path applies to another product.

For omp's manual installation, from the repository root:

```sh
mkdir -p ~/.agents/skills
cp -R skills/publish-pages ~/.agents/skills/
```

For another host that supports directory-based skills, copy the **whole** `skills/publish-pages/` directory, including `scripts/`, into the directory documented by that host. If it has no skill discovery, explicitly load `skills/publish-pages/SKILL.md` into the agent's instructions and invoke `python3 skills/publish-pages/scripts/pages.py` from the clone. A native plugin, if the host supports one, should be a thin adapter invoking this helper and loading the bundled workflow, rather than a second implementation of publishing behavior.

Use the portable installer for private credential storage even when installing a separate host adapter, or inject both `PAGES_URL` and `PAGES_API_KEY` from a trusted secret manager. For a manual, temporary Bash session, the **human** can enter credentials in their own terminal:

```bash
set +x
read -r -p 'Pages API origin (http:// or https://, no path): ' PAGES_URL
read -r -s -p 'Pages API key: ' PAGES_API_KEY
printf '\n'
export PAGES_URL PAGES_API_KEY
python3 skills/publish-pages/scripts/pages.py list
```

The agent process must inherit that environment; exports in a separate shell do not configure an already running agent. Avoid echoing the environment or invoking shell tracing. For persistent settings, keep `client.json` private and mode `0600`; its fields are `url` and `apiKey`, and the helper finds it at the paths above regardless of where the skill is installed. Keep credentials out of plugin manifests, committed config, prompts, reports, attachments, and logs. Share paths and success/error status with the LLM, not secret values.

### Copyable setup prompt

Give your LLM the following prompt from the repository checkout. Supply credentials separately using the private configuration or environment, never in the prompt.

```text
Configure this host to publish to my Pages service using this checkout.

Read docs/agents.md and skills/publish-pages/SKILL.md, inspect the bundled
helper and its --help, and inspect this host's actual installed skill/plugin
mechanism and tool permissions. Use its documented native mechanism: install
the complete bundled skill when supported, or adapt it into a native plugin
only if this host really supports plugins. Otherwise load the bundled skill
explicitly and invoke its helper. Do not claim a built-in Pages plugin exists.
Keep the bundled skill as the workflow source of truth and use the existing
Python helper rather than reimplementing its HTTP client.

Support publish, update (publish --page), list, show, upload, and delete.
Preserve the skill's attachment behavior: repeat --asset, resolve
asset:basename references, retain existing attachments on replacement, reuse
returned URLs to avoid duplicate uploads, and use downloadUrl for forced
downloads. Standalone upload does not rewrite the page. Respect non-atomic
publication: inspect list/show after ambiguous failures before retrying writes.

Discover credentials only through the helper's private configuration or
injected environment. Never print, paste, commit, or embed secrets in prompts,
plugin configuration, or published artifacts. If credentials are absent, ask
me to enter them privately in my terminal, not in chat. Check audience and
network trust before publishing; this service is not production-hardened.

Run the disposable smoke check in docs/agents.md: publish a harmless report
with an image and download, inspect persisted state with show, exercise the
adapter's list/update/upload operations, and verify returned public HTML,
Markdown source, and attachment URLs without a Pages bearer key. Inspect
rendering in a browser when available. Then delete only the smoke page and
verify its public URLs are gone. Report the installed paths and checks actually
performed; explicitly disclose any browser or connectivity limitation.
```

## 4. Validate with a disposable page

Run the following from the clone root after configuring credentials. It uses the repository helper, which loads the same private configuration as the installed copy. To validate a native adapter, exercise its equivalent operations too; a working helper alone does not prove host discovery or adapter wiring.

This smoke check uses only invented content. It creates an isolated local directory, saves the returned page ID immediately for recovery, exercises list/show/update/upload, and checks public content **without an Authorization header**. It does not read or print credential files. If a write fails, follow the bundled skill's recovery instructions before retrying; inspect any saved state in the smoke directory.

```bash
SMOKE_DIR=$(mktemp -d)
export SMOKE_DIR
printf 'Smoke files: %s\n' "$SMOKE_DIR"
python3 - <<'PY'
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import urlopen

work = Path(os.environ['SMOKE_DIR'])
helper = Path('skills/publish-pages/scripts/pages.py').resolve()

def run(*args):
    result = subprocess.run([sys.executable, str(helper), *map(str, args)],
                            check=True, stdout=subprocess.PIPE, text=True)
    return json.loads(result.stdout)

def fetch(url):
    # No Pages credentials are added to public reads.
    with urlopen(url, timeout=30) as response:
        return response.read(), response.headers

image = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=')
(work / 'pixel.png').write_bytes(image)
(work / 'measurements.csv').write_text('check,result\nsmoke,ok\n')
(work / 'appendix.txt').write_text('Harmless standalone upload.\n')
(work / 'report.md').write_text(
    '# Agent integration smoke\n\nHarmless disposable content.\n\n'
    '![Smoke pixel](asset:pixel.png)\n\n'
    '[Download CSV](asset:measurements.csv)\n')
title = 'Agent integration smoke ' + work.name
print('Smoke title:', title, flush=True)
page = run('publish', work / 'report.md', '--title', title,
           '--description', 'Disposable integration check',
           '--asset', work / 'pixel.png', '--asset', work / 'measurements.csv',
           '--json')
(work / 'page.json').write_text(json.dumps(page))
identifier = page['id']
assert any(p['id'] == identifier for p in run('list')['pages'])
shown = run('show', identifier)
assert len(shown['assets']) == 2 and 'asset:' not in shown['markdown']
run('upload', identifier, work / 'appendix.txt')
# Reuse persisted asset URLs; updating must not upload the same files again.
(work / 'report.md').write_text(shown['markdown'] + '\nUpdate verified.\n')
run('publish', work / 'report.md', '--page', identifier,
    '--title', title,
    '--description', 'Disposable integration check', '--json')
shown = run('show', identifier)
assert 'Update verified.' in shown['markdown'] and len(shown['assets']) == 3
(work / 'page.json').write_text(json.dumps(shown))
html, _ = fetch(shown['url'])
assert b'Agent integration smoke' in html and b'Update verified.' in html
source, _ = fetch(shown['url'].rstrip('/') + '/source.md')
assert source.decode('utf-8') == shown['markdown']
for asset in shown['assets']:
    expected = (work / asset['name']).read_bytes()
    body, _ = fetch(asset['url'])
    assert body == expected, asset['name']
    body, headers = fetch(asset['downloadUrl'])
    assert body == expected and 'attachment' in headers.get('Content-Disposition', '')
print('Authenticated publish/list/show/upload/update and unauthenticated reads passed.')
print('Open before deletion:', shown['url'])
print('Page ID:', identifier)
PY
```

A nonzero result is a failed check, not successful completion. The helper prints redacted error and recovery information to stderr; inspect that information before retrying. Never expose credentials to diagnose a failure. When available, open the printed URL in a browser before deleting it: verify the heading, image, attachment links, and CSV download. This smoke does not cover every rendering feature; use the bundled skill's rendering checks when publishing reports that contain tables, code, or Mermaid.

After verification, delete **only this smoke page**. Keep the same shell and `SMOKE_DIR` value:

```bash
python3 - <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import urlopen

work = Path(os.environ['SMOKE_DIR'])
page = json.loads((work / 'page.json').read_text())
helper = Path('skills/publish-pages/scripts/pages.py').resolve()
subprocess.run([sys.executable, str(helper), 'delete', page['id']], check=True)
result = subprocess.run([sys.executable, str(helper), 'show', page['id']],
                        capture_output=True, text=True)
assert result.returncode != 0 and 'HTTP 404' in result.stderr
urls = [page['url'], page['url'].rstrip('/') + '/source.md']
urls += [a['url'] for a in page['assets']]
for url in urls:
    try:
        with urlopen(url, timeout=30):
            raise AssertionError('Deleted content remains readable: ' + url)
    except HTTPError as error:
        assert error.code == 404, (url, error.code)
print('Deletion and public page/source/asset removal verified.')
PY
```

Once deletion succeeds, remove the generated local smoke directory. If interrupted, recover its page ID from `page.json`; if no state file was saved, locate the uniquely intended smoke page with `list` and inspect `show` before deleting anything. Deletion cannot revoke copies already downloaded by readers.

Setup is complete when the host loads its workflow, its client or adapter can perform the requested operations, the disposable page's persisted and public content was verified, and that page and its assets are gone. Report only checks actually exercised, including any browser limitation.
