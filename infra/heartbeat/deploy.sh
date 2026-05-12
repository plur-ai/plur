#!/usr/bin/env bash
# deploy.sh — run on nightshift as root (or via sudo)
# Prereq: DNS A record heartbeat.plur-ai.org → 209.38.195.208 must already propagate
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Creating system user"
id plur-heartbeat &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin plur-heartbeat

echo "==> Installing backend"
mkdir -p /opt/plur-heartbeat
cp "$SCRIPT_DIR/server.py" /opt/plur-heartbeat/server.py
chown -R plur-heartbeat:plur-heartbeat /opt/plur-heartbeat

echo "==> Creating data directory"
mkdir -p /var/lib/plur-heartbeat
chown plur-heartbeat:plur-heartbeat /var/lib/plur-heartbeat

echo "==> Installing systemd unit"
cp "$SCRIPT_DIR/plur-heartbeat.service" /etc/systemd/system/plur-heartbeat.service
systemctl daemon-reload
systemctl enable --now plur-heartbeat
systemctl status plur-heartbeat --no-pager

echo "==> Installing nginx config"
cp "$SCRIPT_DIR/nginx-heartbeat.conf" /etc/nginx/sites-available/heartbeat.plur-ai.org
ln -sf /etc/nginx/sites-available/heartbeat.plur-ai.org /etc/nginx/sites-enabled/
nginx -t

echo ""
echo "==> Next: obtain TLS cert (DNS must have propagated first)"
echo "    certbot --nginx -d heartbeat.plur-ai.org --non-interactive --agree-tos -m gregor@datafund.io"
echo ""
echo "==> After certbot succeeds:"
echo "    systemctl reload nginx"
echo ""
echo "==> Smoke test:"
echo "    curl -sS -o /dev/null -w '%{http_code}' -X POST https://heartbeat.plur-ai.org/v1/heartbeat \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"install_id\":\"00000000-0000-4000-8000-000000000000\",\"version\":\"0.9.4\",\"platform\":\"linux\",\"date\":\"2026-05-12\",\"learn_count\":1,\"recall_count\":0,\"session_count\":1}'"
