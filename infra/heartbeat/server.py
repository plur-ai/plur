#!/usr/bin/env python3
"""
plur heartbeat ingress — listens on 127.0.0.1:8001
Appends validated payloads to /var/lib/plur-heartbeat/YYYY-MM-DD.jsonl
No external dependencies beyond stdlib.
"""
import json
import os
import re
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

DATA_DIR = Path(os.environ.get("HEARTBEAT_DATA_DIR", "/var/lib/plur-heartbeat"))
BIND_HOST = os.environ.get("HEARTBEAT_HOST", "127.0.0.1")
BIND_PORT = int(os.environ.get("HEARTBEAT_PORT", "8001"))
MAX_BODY = 1024  # bytes
SOCKET_TIMEOUT = int(os.environ.get("HEARTBEAT_TIMEOUT", "10"))
# Security audit 2026-11-06: the endpoint is unauthenticated, so what it
# retains must be bounded by construction, not only by the proxy's rate limit.
# One record per install_id per UTC day, and a hard cap on each day's file.
MAX_DAILY_BYTES = int(os.environ.get("HEARTBEAT_MAX_DAILY_BYTES", str(16 * 1024 * 1024)))
MAX_COUNT = 10**9
MAX_VERSION_LEN = 64

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[\w.]+)?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PLATFORMS = {"linux", "darwin", "win32"}
KNOWN_FIELDS = frozenset({"install_id", "version", "platform", "date", "learn_count", "recall_count", "session_count"})


def validate(payload: dict) -> Optional[str]:
    """Return error string or None if valid."""
    unknown = set(payload.keys()) - KNOWN_FIELDS
    if unknown:
        return f"unknown fields: {', '.join(sorted(unknown))}"
    required = KNOWN_FIELDS
    missing = required - payload.keys()
    if missing:
        return f"missing fields: {', '.join(sorted(missing))}"
    if not isinstance(payload["install_id"], str) or not UUID_RE.match(payload["install_id"]):
        return "install_id must be UUID v4"
    if not isinstance(payload["version"], str) or len(payload["version"]) > MAX_VERSION_LEN or not VERSION_RE.match(payload["version"]):
        return "version must match semver"
    if payload["platform"] not in PLATFORMS:
        return f"platform must be one of {PLATFORMS}"
    if not isinstance(payload["date"], str) or not DATE_RE.match(payload["date"]):
        return "date must be YYYY-MM-DD"
    for field in ("learn_count", "recall_count", "session_count"):
        if not isinstance(payload[field], int) or isinstance(payload[field], bool) or payload[field] < 0 or payload[field] > MAX_COUNT:
            return f"{field} must be non-negative integer"
    return None


_seen_lock = threading.Lock()
_seen_day: Optional[str] = None
_seen_ids: set = set()


def _load_seen(path: Path) -> set:
    ids = set()
    try:
        with open(path) as f:
            for line in f:
                try:
                    ids.add(json.loads(line).get("install_id"))
                except (json.JSONDecodeError, AttributeError):
                    continue
    except FileNotFoundError:
        pass
    return ids


def persist(payload: dict, data_dir: Path, date_str: str) -> str:
    """Append one heartbeat; returns 'written', 'duplicate' or 'full'."""
    global _seen_day, _seen_ids
    out_path = data_dir / f"{date_str}.jsonl"
    line = json.dumps(payload, separators=(",", ":")) + "\n"
    with _seen_lock:
        if _seen_day != date_str:
            _seen_day, _seen_ids = date_str, _load_seen(out_path)
        if payload["install_id"] in _seen_ids:
            return "duplicate"
        data_dir.mkdir(parents=True, exist_ok=True)
        size = out_path.stat().st_size if out_path.exists() else 0
        if size + len(line) > MAX_DAILY_BYTES:
            return "full"
        with open(out_path, "a") as f:
            f.write(line)
        _seen_ids.add(payload["install_id"])
        return "written"


class HeartbeatHandler(BaseHTTPRequestHandler):
    timeout = SOCKET_TIMEOUT

    def log_message(self, fmt, *args):
        # Suppress default access log (contains client IP)
        pass

    def send_plain(self, code: int, body: str = ""):
        encoded = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)

    def do_POST(self):
        if self.path != "/v1/heartbeat":
            self.send_plain(404, "not found")
            return

        ct = self.headers.get("Content-Type", "")
        if "application/json" not in ct:
            self.send_plain(400, "Content-Type must be application/json")
            return

        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY:
            self.send_plain(400, "payload too large")
            return

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self.send_plain(400, "invalid JSON")
            return

        if not isinstance(payload, dict):
            self.send_plain(400, "payload must be a JSON object")
            return

        err = validate(payload)
        if err:
            self.send_plain(400, err)
            return

        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if persist(payload, DATA_DIR, date_str) == "full":
            self.send_plain(429, "daily capacity reached")
            return

        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        self.send_plain(405, "method not allowed")

    def do_HEAD(self):
        self.send_plain(405, "method not allowed")


def main():
    server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), HeartbeatHandler)
    print(f"plur-heartbeat listening on {BIND_HOST}:{BIND_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
