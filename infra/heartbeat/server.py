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
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DATA_DIR = Path(os.environ.get("HEARTBEAT_DATA_DIR", "/var/lib/plur-heartbeat"))
BIND_HOST = os.environ.get("HEARTBEAT_HOST", "127.0.0.1")
BIND_PORT = int(os.environ.get("HEARTBEAT_PORT", "8001"))
MAX_BODY = 1024  # bytes

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[\w.]+)?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PLATFORMS = {"linux", "darwin", "win32"}


def validate(payload: dict) -> str | None:
    """Return error string or None if valid."""
    required = {"install_id", "version", "platform", "date", "learn_count", "recall_count", "session_count"}
    missing = required - payload.keys()
    if missing:
        return f"missing fields: {', '.join(sorted(missing))}"
    if not isinstance(payload["install_id"], str) or not UUID_RE.match(payload["install_id"]):
        return "install_id must be UUID v4"
    if not isinstance(payload["version"], str) or not VERSION_RE.match(payload["version"]):
        return "version must match semver"
    if payload["platform"] not in PLATFORMS:
        return f"platform must be one of {PLATFORMS}"
    if not isinstance(payload["date"], str) or not DATE_RE.match(payload["date"]):
        return "date must be YYYY-MM-DD"
    for field in ("learn_count", "recall_count", "session_count"):
        if not isinstance(payload[field], int) or payload[field] < 0:
            return f"{field} must be non-negative integer"
    return None


class HeartbeatHandler(BaseHTTPRequestHandler):
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
        out_path = DATA_DIR / f"{date_str}.jsonl"
        DATA_DIR.mkdir(parents=True, exist_ok=True)

        line = json.dumps(payload, separators=(",", ":")) + "\n"
        with open(out_path, "a") as f:
            f.write(line)

        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        self.send_plain(405, "method not allowed")

    def do_HEAD(self):
        self.send_plain(405, "method not allowed")


def main():
    server = HTTPServer((BIND_HOST, BIND_PORT), HeartbeatHandler)
    print(f"plur-heartbeat listening on {BIND_HOST}:{BIND_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
