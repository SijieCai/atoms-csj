#!/usr/bin/env bash
set -euo pipefail

# One-click bootstrap for Ubuntu 24.04 LTS (Aliyun ECS / Lightweight Application Server)
# Usage:
#   sudo bash deploy/setup-ecs.sh [domain]
# Default domain: atoms.maplink.site

DOMAIN="${1:-atoms.maplink.site}"
APP_DIR="/opt/atoms"

echo "[1/6] Ensuring swap space on low-memory ECS..."
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "[2/6] Installing base tools and Node.js 24 LTS..."
apt-get update -y
apt-get install -y curl git rsync ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
echo "Node version: $(node -v), npm version: $(npm -v)"

echo "[3/6] Installing dependencies and building production bundle in ${APP_DIR}..."
mkdir -p "${APP_DIR}"
cd "${APP_DIR}"

if [ ! -f "${APP_DIR}/.env" ]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  echo "WARNING: Created ${APP_DIR}/.env from .env.example — please edit GLM_API_KEY, DEMO_USERS, and SESSION_SECRET!"
fi

npm install --no-audit --no-fund
npm run setup:template
npm run build:prod

echo "[4/6] Configuring systemd service..."
cp "${APP_DIR}/deploy/atoms.service" /etc/systemd/system/atoms.service
systemctl daemon-reload
systemctl enable atoms
systemctl restart atoms

echo "[5/6] Checking reverse proxy (ports 80/443)..."
if ss -tlnp | grep -qE ':(80|443)\s' && ! systemctl is-active --quiet caddy; then
  echo "Detected an existing reverse proxy (e.g. Docker Caddy) already listening on 80/443."
  echo "Skipping host Caddy installation. Add the '${DOMAIN}' site block to your existing Caddyfile."
else
  if ! command -v caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi

  cat >/etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    encode zstd gzip
    request_body {
        max_size 10MB
    }
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
EOF
  systemctl enable caddy
  systemctl restart caddy
fi

echo "[6/6] Verifying local health..."
sleep 2
curl -fsS http://127.0.0.1:3000/api/health && echo ""
echo "Deployment complete! Access URL: https://${DOMAIN}"
