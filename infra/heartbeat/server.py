#!/usr/bin/env python3
"""
plur heartbeat ingress — listens on 127.0.0.1:8001
Appends validated payloads to /var/lib/plur-heartbeat/YYYY-MM-DD.jsonl
No external dependencies beyond stdlib.
"""
import json
import fcntl
import os
import re
import sys
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

DATA_DIR = Path(os.environ.get("HEARTBEAT_DATA_DIR", "/var/lib/plur-heartbeat"))
BIND_HOST = os.environ.get("HEARTBEAT_HOST", "127.0.0.1")
BIND_PORT = int(os.environ.get("HEARTBEAT_PORT", "8001"))
MAX_BODY = 1024  # bytes
SOCKET_TIMEOUT = int(os.environ.get("HEARTBEAT_TIMEOUT", "10"))

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
    if not isinstance(payload, dict):
        return "payload must be a JSON object"
    unknown = set(payload.keys()) - KNOWN_FIELDS
    if unknown:
        return f"unknown fields: {', '.join(sorted(unknown))}"
    required = KNOWN_FIELDS
    missing = required - payload.keys()
    if missing:
        return f"missing fields: {', '.join(sorted(missing))}"
    if not isinstance(payload["install_id"], str) or not UUID_RE.fullmatch(payload["install_id"]):
        return "install_id must be UUID v4"
    if not isinstance(payload["version"], str) or not VERSION_RE.fullmatch(payload["version"]):
        return "version must match semver"
    if not isinstance(payload["platform"], str) or payload["platform"] not in PLATFORMS:
        return f"platform must be one of {PLATFORMS}"
    if not isinstance(payload["date"], str) or not DATE_RE.fullmatch(payload["date"]):
        return "date must be YYYY-MM-DD"
    try:
        date.fromisoformat(payload["date"])
    except ValueError:
        return "date must be a valid calendar date"
    for field in ("learn_count", "recall_count", "session_count"):
        if not isinstance(payload[field], int) or isinstance(payload[field], bool) or payload[field] < 0:
            return f"{field} must be non-negative integer"
    return None


def append_record(out_path: Path, payload: dict) -> None:
    """Serialize append/recovery across threads and processes, preserving bytes."""
    out_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    line = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
    fd = os.open(out_path, os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        size = os.fstat(fd).st_size
        # A previous process can have stopped midway through a record. Keep
        # those bytes, but never fuse the next accepted record with that tail.
        if size and os.pread(fd, 1, size - 1) != b"\n":
            line = b"\n" + line
        if os.write(fd, line) != len(line):
            raise OSError("incomplete heartbeat append")
        os.fsync(fd)
        # Recheck ancestry on retry too: an interrupted earlier creation may
        # have left directories present without durable parent entries.
        directory = out_path.parent.resolve()
        for directory in [directory, *directory.parents]:
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        os.close(fd)  # also releases flock, including on an interrupted append


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
        if ct.split(";", 1)[0].strip().lower() != "application/json":
            self.send_plain(400, "Content-Type must be application/json")
            return

        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,6}", lengths[0]):
            self.send_plain(400, "invalid Content-Length")
            return
        length = int(lengths[0])
        if length <= 0 or length > MAX_BODY:
            self.send_plain(400, "payload too large")
            return

        try:
            raw = self.rfile.read(length)
        except (TimeoutError, OSError):
            self.send_plain(408, "incomplete request")
            return
        if len(raw) != length:
            self.send_plain(400, "incomplete request")
            return
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
            self.send_plain(400, "invalid JSON")
            return

        if not isinstance(payload, dict):
            self.send_plain(400, "payload must be a JSON object")
            return

        err = validate(payload)
        if err:
            self.send_plain(400, err)
            return

        delivery_ids = self.headers.get_all("Idempotency-Key", [])
        if len(delivery_ids) > 1 or (delivery_ids and not UUID_RE.fullmatch(delivery_ids[0])):
            self.send_plain(400, "invalid Idempotency-Key")
            return
        if delivery_ids:
            # A retry keeps this identity. Raw arrivals remain an append-only
            # record; queries count each logical delivery once.
            payload = {**payload, "_delivery_id": delivery_ids[0]}

        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        out_path = DATA_DIR / f"{date_str}.jsonl"
        try:
            append_record(out_path, payload)
        except OSError:
            self.send_plain(503, "storage unavailable")
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
