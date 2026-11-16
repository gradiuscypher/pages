"""Dependency-free Pages client for Python 3 (save this file as pages.py).

    from pages import Client, PagesError
    client = Client("https://pages.example.com")  # optional second argument: API key
    page = client.publish("Report", "![Chart](asset:chart.png)", assets=["chart.png"])

Client(base_url, api_key=None, *, timeout=30) accepts an HTTP(S) origin and a
positive per-request socket timeout in seconds. No environment/config is read.
Methods return server JSON dictionaries; delete/delete_asset return None:
    list()
    get(page_id)
    create(title, markdown, description="")
    update(page_id, title, markdown, description="")  # complete replacement
    delete(page_id)
    upload(page_id, path)                          # one local file
    delete_asset(page_id, asset_id)
    publish(title, markdown, description="", assets=(), page_id=None)

publish accepts Markdown CONTENT, not a filename. It preflights local asset paths,
creates a page (or replaces page_id), uploads every asset, substitutes asset:basename
references (percent-encode spaces/delimiters), and saves the final Markdown. Existing
assets are retained. Publication is not atomic: PagesError.page_id/recovery_url
identify partial work when known. Inspect get/list before retrying uncertain writes.
PagesError.status is an HTTP status or None. Redirects and automatic retries are
never used. Public page/asset URLs may use a different origin; no requests or keys
are sent to those URLs. Use HTTPS outside trusted local networks.
"""

import http.client
import json
import math
import mimetypes
from pathlib import Path
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import uuid


_ASSET_REFERENCE = re.compile(r"asset:([^\s<>\"'`()\[\]{}]+)")


class PagesError(Exception):
    """A validation, HTTP, network, or partial-publication error (no response body)."""

    def __init__(self, message, *, status=None, page_id=None, recovery_url=None):
        super().__init__(message)
        self.status = status
        self.page_id = page_id
        self.recovery_url = recovery_url


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _url(value, label, *, origin=False):
    try:
        if not isinstance(value, str) or not value or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.fragment or "\\" in value):
            raise ValueError
        parsed.port
        if origin and (parsed.path not in ("", "/") or parsed.query or "?" in value or "#" in value):
            raise ValueError
    except (ValueError, TypeError):
        raise PagesError(f"{label} must be an absolute HTTP(S) {'origin' if origin else 'URL'} without credentials or fragment") from None
    return value.rstrip("/") if origin else value


def _identifier(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        raise PagesError("Page and asset IDs must be UUIDs") from None


def _document(title, markdown, description):
    if not isinstance(title, str) or not title.strip():
        raise PagesError("Title must be a nonempty string")
    if not isinstance(markdown, str) or not isinstance(description, str):
        raise PagesError("Markdown and description must be strings")
    return {"title": title, "markdown": markdown, "description": description}


def _assets(paths):
    result = {}
    for value in paths:
        try:
            path = Path(value).expanduser()
        except (TypeError, ValueError):
            raise PagesError("Assets must be local file paths") from None
        name = path.name
        if not name or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise PagesError("Asset basenames must not contain control characters")
        if name in result:
            raise PagesError(f"Duplicate asset basename {name!r}; rename files before publishing")
        try:
            if not path.is_file():
                raise PagesError(f"Asset is not a regular file: {path}")
            with path.open("rb"):
                pass
        except OSError:
            raise PagesError(f"Cannot read asset: {path}") from None
        result[name] = path
    return result


class Client:
    def __init__(self, base_url, api_key=None, *, timeout=30):
        self.base_url = _url(base_url, "Pages URL", origin=True)
        if api_key is None:
            api_key = ""
        if not isinstance(api_key, str) or any(ord(c) < 33 or ord(c) > 126 for c in api_key):
            raise PagesError("API key must be printable ASCII without whitespace, or empty")
        if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise PagesError("Timeout must be a positive finite number of seconds")
        self._api_key = api_key
        self.timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirects())

    def _request(self, method, route, payload=None, *, body=None, content_type=None):
        headers = {"Accept": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            content_type = "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.base_url + route, data=body, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                if response.status == 204:
                    return None
                raw = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            raise PagesError(f"{method} {route}: HTTP {status}", status=status) from None
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError, http.client.HTTPException):
            raise PagesError(f"{method} {route}: network failure or timeout; server may have processed the request") from None
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            raise PagesError(f"{method} {route}: invalid JSON; request may have succeeded") from None
        if not isinstance(result, dict):
            raise PagesError(f"{method} {route}: expected a JSON object; request may have succeeded")
        return result

    def list(self):
        return self._request("GET", "/api/pages")

    def get(self, page_id):
        return self._request("GET", f"/api/pages/{_identifier(page_id)}")

    def create(self, title, markdown, description=""):
        return self._request("POST", "/api/pages", _document(title, markdown, description))

    def update(self, page_id, title, markdown, description=""):
        return self._request("PUT", f"/api/pages/{_identifier(page_id)}", _document(title, markdown, description))

    def delete(self, page_id):
        return self._request("DELETE", f"/api/pages/{_identifier(page_id)}")

    def delete_asset(self, page_id, asset_id):
        return self._request("DELETE", f"/api/pages/{_identifier(page_id)}/assets/{_identifier(asset_id)}")

    def upload(self, page_id, path):
        identifier = _identifier(page_id)
        path = next(iter(_assets([path]).values()))
        try:
            data = path.read_bytes()
        except OSError:
            raise PagesError(f"Cannot read asset: {path}") from None
        boundary = "pages-" + uuid.uuid4().hex
        fallback = path.name.encode("ascii", "replace").decode("ascii").replace("\\", "\\\\").replace('"', '\\"')
        encoded_name = urllib.parse.quote(path.name, safe="")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        head = (f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{fallback}"; filename*=UTF-8\'\'{encoded_name}\r\n'
                f"Content-Type: {mime}\r\n\r\n").encode("ascii")
        result = self._request("POST", f"/api/pages/{identifier}/assets",
                               body=head + data + f"\r\n--{boundary}--\r\n".encode("ascii"),
                               content_type=f"multipart/form-data; boundary={boundary}")
        for field in ("url", "downloadUrl"):
            _url(result.get(field), f"Asset {field}")
        return result

    def publish(self, title, markdown, description="", assets=(), page_id=None):
        payload = _document(title, markdown, description)
        identifier = _identifier(page_id) if page_id is not None else None
        prepared = _assets(assets)
        references = {}
        for match in _ASSET_REFERENCE.finditer(markdown):
            token = match.group(1)
            try:
                if re.search(r"%(?![0-9A-Fa-f]{2})", token):
                    raise ValueError
                name = urllib.parse.unquote(token, errors="strict")
            except (UnicodeError, ValueError):
                raise PagesError(f"Invalid percent-encoded asset reference: {token}") from None
            if name not in prepared:
                raise PagesError(f"No asset supplied for asset:{token}")
            references[token] = name
        recovery_url = None
        try:
            current = self.get(identifier) if identifier else self.create(**payload)
            # Retain the ID even when the server's public URL is malformed.
            identifier = _identifier(current.get("id"))
            recovery_url = _url(current.get("url"), "Returned page URL")
            uploaded = {name: self.upload(identifier, path)["url"] for name, path in prepared.items()}
            payload["markdown"] = _ASSET_REFERENCE.sub(lambda match: uploaded[references[match.group(1)]], markdown)
            result = self.update(identifier, **payload)
            _identifier(result.get("id"))
            _url(result.get("url"), "Returned page URL")
            return result
        except (PagesError, KeyboardInterrupt) as error:
            message = str(error) or "Interrupted"
            if identifier:
                message += f"\nPartial publication; recovery page ID: {identifier}"
                if recovery_url:
                    message += f"\nRecovery URL: {recovery_url}"
                message += "\nInspect get before retrying; existing attachments are retained."
            else:
                message += "\nIf creation reached the server, use list before retrying."
            raise PagesError(message, status=getattr(error, "status", None),
                             page_id=identifier, recovery_url=recovery_url) from None
