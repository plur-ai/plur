#!/usr/bin/env bash
# deploy.sh — run on the heartbeat server with sudo access
# Required env vars:
#   CERTBOT_EMAIL   — email address for Let's Encrypt registration
# Optional env vars:
#   DEPLOY_USER     — unix user that owns the heartbeat files (default: current user)
# Phase 1 (HTTP): works immediately once port 80 is open on the server
# Phase 2 (HTTPS): requires DNS A record heartbeat.plur-ai.org pointed at this server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_USER="${DEPLOY_USER:-$(whoami)}"
: "${CERTBOT_EMAIL:?CERTBOT_EMAIL env var is required for Phase 2 (certbot TLS)}"

echo "==> Installing backend"
sudo mkdir -p /opt/plur-heartbeat /var/lib/plur-heartbeat /var/lib/plur-metrics
sudo cp "$SCRIPT_DIR/server.py" /opt/plur-heartbeat/server.py
sudo cp "$SCRIPT_DIR/query.py" /opt/plur-heartbeat/query.py 2>/dev/null || true
sudo chown -R "${DEPLOY_USER}:${DEPLOY_USER}" /opt/plur-heartbeat /var/lib/plur-heartbeat /var/lib/plur-metrics

echo "==> Installing systemd units (heartbeat ingress + daily MAU timer)"
# Both service files use __DEPLOY_USER__ as a placeholder — expand at install time.
# Never `cp` these directly; systemd does not expand shell variables in User=.
sed "s/__DEPLOY_USER__/${DEPLOY_USER}/g" "$SCRIPT_DIR/plur-heartbeat.service" | sudo tee /etc/systemd/system/plur-heartbeat.service > /dev/null
sed "s/__DEPLOY_USER__/${DEPLOY_USER}/g" "$SCRIPT_DIR/plur-metrics.service" | sudo tee /etc/systemd/system/plur-metrics.service > /dev/null
sudo cp "$SCRIPT_DIR/plur-metrics.timer" /etc/systemd/system/plur-metrics.timer
sudo systemctl daemon-reload
sudo systemctl enable --now plur-heartbeat
sudo systemctl enable --now plur-metrics.timer
sudo systemctl status plur-heartbeat --no-pager
sudo systemctl status plur-metrics.timer --no-pager

echo "==> Installing nginx config (Phase 1: HTTP)"
sudo cp "$SCRIPT_DIR/nginx-heartbeat-http.conf" /etc/nginx/sites-available/heartbeat-http
sudo ln -sf /etc/nginx/sites-available/heartbeat-http /etc/nginx/sites-enabled/heartbeat-http
sudo cp "$SCRIPT_DIR/nginx-heartbeat.conf" /etc/nginx/sites-available/heartbeat.plur-ai.org
echo "    HTTP config enabled; HTTPS config installed but not enabled (needs DNS + certbot)"

echo "==> Opening port 80"
sudo ufw allow 80/tcp comment 'heartbeat-http'

sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "==> Phase 1 smoke test (HTTP — replace <server-ip> with this host's public IP):"
echo "    curl -sS -o /dev/null -w '%{http_code}' -X POST http://<server-ip>/v1/heartbeat \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"install_id\":\"00000000-0000-4000-8000-000000000000\",\"version\":\"0.12.0\",\"platform\":\"linux\",\"date\":\"\$(date +%Y-%m-%d)\",\"learn_count\":1,\"recall_count\":0,\"session_count\":1}'"
echo ""
echo "==> Phase 2 upgrade (after DNS A record heartbeat.plur-ai.org points at this server):"
echo "    certbot --nginx -d heartbeat.plur-ai.org --non-interactive --agree-tos -m \"\${CERTBOT_EMAIL}\""
echo "    sudo rm /etc/nginx/sites-enabled/heartbeat-http"
echo "    sudo ln -sf /etc/nginx/sites-available/heartbeat.plur-ai.org /etc/nginx/sites-enabled/"
echo "    sudo nginx -t && sudo systemctl reload nginx"
echo "    # Also update client PLUR_TELEMETRY_ENDPOINT or let default heartbeat.plur-ai.org resolve"
