#!/usr/bin/env bash
set -euo pipefail

# Build production artifacts locally (avoids Monaco/Vite OOM on 2GB ECS),
# sync source + dist + .env to Aliyun ECS, and restart atoms.service.
#
# Usage:
#   bash deploy/deploy-ecs.sh
# Optional overrides:
#   ECS_HOST=116.62.157.145 ECS_USER=root SSH_KEY=~/.ssh/aliyun_ecs.pem PUBLIC_DOMAIN=atoms.maplink.site bash deploy/deploy-ecs.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ECS_HOST="${ECS_HOST:-116.62.157.145}"
ECS_USER="${ECS_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/aliyun_ecs.pem}"
REMOTE_DIR="${REMOTE_DIR:-/opt/atoms}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-atoms.maplink.site}"

SSH_OPTS=(-i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

if [ ! -f "${REPO_ROOT}/.env" ]; then
  echo "ERROR: ${REPO_ROOT}/.env not found. Create it from .env.example first." >&2
  exit 1
fi

echo "[1/5] Building production bundles locally (shared + web + server) ..."
(cd "${REPO_ROOT}" && npm run build:prod)

echo "[2/5] Syncing project source, built dist, and .env to ${ECS_USER}@${ECS_HOST}:${REMOTE_DIR} ..."
ssh "${SSH_OPTS[@]}" "${ECS_USER}@${ECS_HOST}" "mkdir -p '${REMOTE_DIR}'"

rsync -rlzt --no-owner --no-group --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'package-lock.json' \
  --exclude 'templates/fullstack-app/node_modules' \
  --exclude 'templates/fullstack-app/package-lock.json' \
  --exclude 'templates/fullstack-app/dist' \
  --exclude 'templates/fullstack-app/data' \
  --exclude 'data' \
  --exclude '.env.local' \
  --exclude '.env.*.local' \
  --exclude '.DS_Store' \
  -e "ssh ${SSH_OPTS[*]}" \
  "${REPO_ROOT}/" "${ECS_USER}@${ECS_HOST}:${REMOTE_DIR}/"

echo "[3/5] Setting strict permissions on remote .env ..."
ssh "${SSH_OPTS[@]}" "${ECS_USER}@${ECS_HOST}" "chmod 600 '${REMOTE_DIR}/.env'"

echo "[4/5] Ensuring runtime dependencies on ECS and restarting atoms.service ..."
ssh "${SSH_OPTS[@]}" "${ECS_USER}@${ECS_HOST}" "set -euo pipefail
cd '${REMOTE_DIR}'
if [ ! -d node_modules ] || [ '${INSTALL_DEPS:-0}' = '1' ]; then
  npm install --no-audit --no-fund
fi
if [ ! -d templates/fullstack-app/node_modules ] || [ '${INSTALL_DEPS:-0}' = '1' ]; then
  npm run setup:template
fi
cp '${REMOTE_DIR}/deploy/atoms.service' /etc/systemd/system/atoms.service
systemctl daemon-reload
systemctl enable atoms
systemctl restart atoms
"

echo "[5/5] Verifying remote service health ..."
ssh "${SSH_OPTS[@]}" "${ECS_USER}@${ECS_HOST}" "set -euo pipefail
for i in \$(seq 1 15); do
  if curl -fsS http://127.0.0.1:3000/api/health; then
    echo ''
    exit 0
  fi
  sleep 1
done
journalctl -u atoms -n 40 --no-pager >&2
exit 1
"

echo "Deploy succeeded: https://${PUBLIC_DOMAIN}"
