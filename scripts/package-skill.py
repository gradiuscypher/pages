#!/usr/bin/env python3
"""Build a self-contained installer for the Pages agent skill and optional key."""

import argparse
import base64
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent

INSTALLER = '''#!/usr/bin/env python3
"""Pages skill installer. May contain a publishing key; transfer securely."""
import argparse
import base64
import json
import os
from pathlib import Path
import tempfile

PAYLOAD = json.loads(base64.b64decode(__PAYLOAD__))

def main():
    parser = argparse.ArgumentParser(description="Install the Pages omp skill and private configuration for the current user.")
    parser.add_argument("--replace", action="store_true", help="replace existing skill files or differing Pages configuration")
    args = parser.parse_args()
    skill = Path.home() / ".agents" / "skills" / "publish-pages"
    config_dir = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "grds-pages"
    config = config_dir / "client.json"
    files = [(skill / name, content, 0o644) for name, content in PAYLOAD["files"].items()]
    files.append((config, json.dumps(PAYLOAD["config"], indent=2) + "\\n", 0o600))
    # Check every target before writing; a second run is safe when files match.
    for path, content, mode in files:
        if path.is_symlink():
            parser.error(f"Refusing to replace a symbolic link: {path}")
        if path.exists() and path.read_text(encoding="utf-8") != content and not args.replace:
            parser.error(f"Existing file differs: {path}. Use --replace to update this Pages installation.")
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    for path, content, mode in files:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".pages-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(content)
            os.chmod(temporary, mode)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print(f"Installed skill: {skill}")
    print(f"Private configuration: {config} (0600)")
    print(f"Pages URL: {PAYLOAD['config']['url']}")
    print("Start a new omp session. The helper loads configuration automatically; no shell exports are needed.")
    print("Verify: python3 ~/.agents/skills/publish-pages/scripts/pages.py list")
    print("Remove this copied installer after use; it may contain a publishing key.")

if __name__ == "__main__":
    main()
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
    parser.add_argument('--output', type=Path, default=ROOT / '.local' / 'install-pages-skill.py')
    args = parser.parse_args()
    values = {}
    for line in args.env_file.read_text(encoding='utf-8').splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            name, separator, value = line.partition('=')
            if separator:
                values[name.strip()] = value.strip().strip('\"\'')
    key = values.get('PAGES_API_KEY', '')
    url = values.get('PUBLIC_URL', '').rstrip('/')
    try:
        parsed = urlsplit(url)
        parsed.port
    except ValueError:
        parser.error('The environment file must contain a valid PUBLIC_URL HTTP(S) origin.')
    if key and (len(key) < 24 or any(ord(c) < 33 or ord(c) > 126 for c in key)):
        parser.error('PAGES_API_KEY must be printable ASCII without whitespace and at least 24 characters, or empty for an open API.')
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url) or '\\' in url
            or '?' in url or '#' in url):
        parser.error('The environment file must contain a PUBLIC_URL HTTP(S) origin.')
    payload = {
        'config': {'url': url, 'apiKey': key},
        'files': {name: (ROOT / 'skills' / 'publish-pages' / name).read_text(encoding='utf-8')
                  for name in ('SKILL.md', 'scripts/pages.py')},
    }
    encoded = base64.b64encode(json.dumps(payload).encode('utf-8')).decode('ascii')
    content = INSTALLER.replace('__PAYLOAD__', repr(encoded))
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix='.installer-', dir=args.output.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(content)
        os.chmod(temporary, 0o600)
        os.replace(temporary, args.output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f'Created private installer: {args.output} (0600)')
    print('May contain a publishing key. Copy securely; do not commit or serve this file.')


if __name__ == '__main__':
    main()
