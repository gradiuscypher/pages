#!/usr/bin/env python3
"""Publish Markdown and attachments to Pages using only the Python standard library."""

import argparse
import http.client
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


ASSET_REFERENCE = re.compile(r"asset:([^\s<>\"'`()\[\]{}]+)")


class PublishError(Exception):
    pass


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        # Never forward the bearer key to a redirected origin.
        return None


def http_url(value, label, *, base=False):
    if not isinstance(value, str):
        raise PublishError(f"{label} must be an absolute http/https URL")
    try:
        parsed = urllib.parse.urlsplit(value)
        valid = (
            parsed.scheme in ("http", "https")
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and not parsed.fragment
            and not any(character.isspace() or ord(character) < 32 for character in value)
        )
        parsed.port
    except ValueError:
        valid = False
    if not valid or (base and parsed.query):
        raise PublishError(f"{label} must be an absolute http/https URL without credentials"
                           + (", query, or fragment" if base else " or fragment"))
    return value.rstrip("/") if base else value


def page_id(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        raise argparse.ArgumentTypeError("page ID must be a UUID") from None


def positive_timeout(value):
    try:
        result = float(value)
        if math.isfinite(result) and result > 0:
            return result
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("timeout must be a positive number of seconds")


class Client:
    @staticmethod
    def stored_config():
        directory = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        path = directory / "grds-pages" / "client.json"
        try:
            config = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, UnicodeError):
            raise PublishError(f"Cannot read Pages configuration at {path}") from None
        if not isinstance(config, dict):
            raise PublishError(f"Expected a JSON object in {path}")
        return config

    def __init__(self, timeout):
        config = self.stored_config() if not (os.environ.get("PAGES_API_KEY") and os.environ.get("PAGES_URL")) else {}
        self.key = os.environ.get("PAGES_API_KEY") or config.get("apiKey", "")
        if not isinstance(self.key, str) or not self.key or any(ord(character) < 33 or ord(character) > 126 for character in self.key):
            raise PublishError("Configure PAGES_API_KEY or the private Pages client.json (printable ASCII, no whitespace)")
        self.base = http_url(os.environ.get("PAGES_URL") or config.get("url", ""), "Pages URL", base=True)
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirects())

    def redact(self, value):
        text = str(value)
        for secret in sorted({self.key, urllib.parse.quote(self.key, safe=""), json.dumps(self.key)[1:-1]}, key=len, reverse=True):
            text = text.replace(secret, "[REDACTED]")
        return text

    def request(self, method, route, payload=None, *, body=None, content_type=None):
        headers = {"Authorization": f"Bearer {self.key}", "Accept": "application/json"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            content_type = "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.base + route, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read()
                if response.status == 204:
                    return None
        except urllib.error.HTTPError as error:
            # An upstream body can contain credentials, markup, or arbitrary binary data.
            # Status is sufficient to diagnose auth/validation/size/service failures safely.
            status = error.code
            error.close()
            raise PublishError(f"{method} {route}: HTTP {status}") from None
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError, http.client.HTTPException) as error:
            reason = "request timed out" if isinstance(error, (TimeoutError, socket.timeout)) else "network request failed"
            raise PublishError(f"{method} {route}: {reason}; server may have processed the request") from None
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            raise PublishError(f"{method} {route}: server returned invalid JSON; request may have succeeded") from None
        if not isinstance(result, dict):
            raise PublishError(f"{method} {route}: expected a JSON object; request may have succeeded")
        return result

    def upload(self, identifier, path):
        try:
            data = path.read_bytes()
        except OSError as error:
            raise PublishError(f"Cannot read attachment {path}: {error.strerror}") from None
        boundary = "pages-" + uuid.uuid4().hex
        fallback = path.name.encode("ascii", "replace").decode("ascii").replace("\\", "\\\\").replace('"', '\\"')
        encoded_name = urllib.parse.quote(path.name, safe="")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        head = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{fallback}"; filename*=UTF-8\'\'{encoded_name}\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("ascii")
        result = self.request("POST", f"/api/pages/{identifier}/assets", body=head + data + f"\r\n--{boundary}--\r\n".encode("ascii"),
                              content_type=f"multipart/form-data; boundary={boundary}")
        for field in ("url", "downloadUrl"):
            http_url(result.get(field, ""), f"Asset {field}")
        return result


def prepare_assets(paths):
    assets = {}
    for value in paths:
        path = Path(value).expanduser()
        name = path.name
        if name in assets:
            raise PublishError(f"Duplicate attachment basename {name!r}; rename attachments before publishing")
        if not name or any(ord(character) < 32 or ord(character) == 127 for character in name):
            raise PublishError("Attachment basenames must not contain control characters")
        try:
            if not path.is_file():
                raise PublishError(f"Attachment is not a regular file: {path}")
            with path.open("rb"):
                pass
        except OSError as error:
            raise PublishError(f"Cannot open attachment {path}: {error.strerror}") from None
        assets[name] = path
    return assets


def public_page(result):
    try:
        identifier = page_id(result.get("id", ""))
    except argparse.ArgumentTypeError:
        raise PublishError("Server returned a page without a valid ID; request may have succeeded") from None
    url = http_url(result.get("url", ""), "Returned page URL")
    return identifier, url


def publish(client, args):
    try:
        markdown = Path(args.markdown).expanduser().read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise PublishError("Cannot read Markdown file as UTF-8") from None
    if not args.title.strip():
        raise PublishError("Title must not be empty")
    assets = prepare_assets(args.asset)
    references = {}
    for match in ASSET_REFERENCE.finditer(markdown):
        token = match.group(1)
        try:
            name = urllib.parse.unquote(token, errors="strict")
        except UnicodeError:
            raise PublishError(f"Invalid UTF-8 asset reference: {token}") from None
        if name not in assets:
            raise PublishError(f"No --asset supplied for asset:{token}")
        references[token] = name

    payload = {"title": args.title, "description": args.description, "markdown": markdown}
    identifier = args.page
    recovery_url = None
    try:
        if identifier:
            current = client.request("GET", f"/api/pages/{identifier}")
            identifier, recovery_url = public_page(current)
        else:
            current = client.request("POST", "/api/pages", payload)
            # Capture the ID before validating the URL so malformed responses still
            # leave whatever recovery information the server supplied.
            try:
                identifier = page_id(current.get("id", ""))
            except argparse.ArgumentTypeError:
                pass
            identifier, recovery_url = public_page(current)
        uploaded = {}
        for name, path in assets.items():
            uploaded[name] = client.upload(identifier, path)["url"]
        payload["markdown"] = ASSET_REFERENCE.sub(lambda match: uploaded[references[match.group(1)]], markdown)
        result = client.request("PUT", f"/api/pages/{identifier}", payload)
        public_page(result)
        return result
    except (PublishError, KeyboardInterrupt) as error:
        details = str(error) if isinstance(error, PublishError) else "Interrupted"
        if identifier:
            details += f"\nPartial publication; recovery page ID: {identifier}"
            if recovery_url:
                details += f"\nRecovery URL: {recovery_url}"
            details += "\nInspect with show before retrying; existing attachments are retained."
        else:
            details += "\nIf creation reached the server, use list to locate the page before retrying."
        raise PublishError(details) from None


def parser():
    root = argparse.ArgumentParser(
        description="Publish Markdown to Pages using environment variables or private client.json credentials.",
        epilog="PAGES_URL and PAGES_API_KEY override ~/.config/grds-pages/client.json "
               "(or $XDG_CONFIG_HOME/grds-pages/client.json). Requests do not follow redirects. "
               "Public URLs need no bearer key. See each command's --help.",
    )
    root.add_argument("--timeout", type=positive_timeout, default=30, metavar="SECONDS", help="per-request timeout (default: 30)")
    commands = root.add_subparsers(dest="command", required=True)
    create = commands.add_parser("publish", aliases=["create"], help="create or fully replace a page and upload attachments",
                                 description="Preflight files and asset:basename references, create a page if needed, upload attachments, "
                                             "then replace Markdown. Failures retain recoverable pages/attachments; no automatic retry.")
    create.add_argument("markdown", metavar="MARKDOWN_FILE", help="UTF-8 Markdown file")
    create.add_argument("--title", required=True, help="page title")
    create.add_argument("--description", default="", help="page summary (default: empty)")
    create.add_argument("--asset", action="append", default=[], metavar="PATH", help="attach a file; repeat for more (basenames must be unique)")
    create.add_argument("--page", type=page_id, metavar="ID", help="fully replace this existing page; preserve its attachments")
    create.add_argument("--json", action="store_true", help="print full returned page JSON instead of its public URL")
    listing = commands.add_parser("list", help="list page metadata as JSON")
    listing.set_defaults(json=True)
    show = commands.add_parser("show", help="show a page's full JSON")
    show.add_argument("page", type=page_id, metavar="ID")
    delete = commands.add_parser("delete", help="permanently delete a page and all its attachments",
                                 description="Delete the specified page and all its attachments. Saved reader copies are unaffected. "
                                             "A missing page is an error; writes are not automatically retried.")
    delete.add_argument("page", type=page_id, metavar="ID")
    upload = commands.add_parser("upload", help="attach one file to an existing page; print its asset JSON")
    upload.add_argument("page", type=page_id, metavar="ID")
    upload.add_argument("file", metavar="PATH")
    return root


def main():
    args = parser().parse_args()
    client = None
    try:
        client = Client(args.timeout)
        if args.command in ("publish", "create"):
            result = publish(client, args)
            text = json.dumps(result, ensure_ascii=False, indent=2) if args.json else result["url"]
        elif args.command == "list":
            text = json.dumps(client.request("GET", "/api/pages"), ensure_ascii=False, indent=2)
        elif args.command == "show":
            text = json.dumps(client.request("GET", f"/api/pages/{args.page}"), ensure_ascii=False, indent=2)
        elif args.command == "delete":
            client.request("DELETE", f"/api/pages/{args.page}")
            text = f"Deleted page {args.page} and its attachments."
        else:
            assets = prepare_assets([args.file])
            current = client.request("GET", f"/api/pages/{args.page}")
            identifier, recovery_url = public_page(current)
            try:
                result = client.upload(identifier, next(iter(assets.values())))
            except (PublishError, KeyboardInterrupt) as error:
                raise PublishError(f"{error or 'Interrupted'}\nRecovery page ID: {identifier}\nRecovery URL: {recovery_url}\n"
                                   "Inspect show output before retrying; the attachment may have been saved.") from None
            text = json.dumps(result, ensure_ascii=False, indent=2)
        print(client.redact(text))
        return 0
    except (PublishError, KeyboardInterrupt) as error:
        message = str(error) or "Interrupted"
        print("pages: " + (client.redact(message) if client else message), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
