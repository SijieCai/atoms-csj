#!/usr/bin/env bash
set -euo pipefail

# One-click bootstrap for Ubuntu 24.04 LTS (Aliyun ECS / Lightweight Application Server)
# Usage:
#   sudo bash deploy/setup-ecs.sh [optional-domain]
# Example (IP only):
#   sudo bash deploy/setup-ecs.sh
# Example (with domain + auto HTTPS):
#   sudo bash deploy/setup-ecs.sh demo.yourdomain.com

DOMAIN="${1:-}"
APP_DIR="/opt/atoms"

echo "[1/5] Installing base tools and Node.js 24 LTS..."
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
echo "Node version: $(node -v), npm version: $(npm -v)"

echo "[2/5] Installing Caddy reverse proxy..."
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "[3/5] Installing dependencies and building app in ${APP_DIR}..."
mkdir -p "${APP_DIR}"
cd "${APP_DIR}"

if [ ! -f "${APP_DIR}/.env" ]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  echo "WARNING: Created ${APP_DIR}/.env from .env.example — please edit GLM_API_KEY, DEMO_USERS, and SESSION_SECRET!"
fi

npm install --no-audit --no-fund
npm run setup:template
npm run build

echo "[4/5] Configuring systemd service..."
cp "${APP_DIR}/deploy/atoms.service" /etc/systemd/system/atoms.service
systemctl daemon-reload
systemctl enable atoms
systemctl restart atoms

echo "[5/5] Configuring Caddy..."
if [ -n "${DOMAIN}" ]; then
  cat >/etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
EOF
else
  cp "${APP_DIR}/deploy/Caddyfile" /etc/caddy/Caddyfile
fi

systemctl enable caddy
systemctl restart caddy

echo ""
echo "Deployment complete!"
echo "Check service status: systemctl status atoms"
echo "Check logs:           journalctl -u atoms -f"
if [ -n "${DOMAIN}" ]; then
  echo "Access URL:           https://${DOMAIN}"
else
  echo "Access URL:           http://<YOUR_ECS_PUBLIC_IP>"
fi
