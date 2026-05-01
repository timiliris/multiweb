#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "À lancer en root." >&2
  exit 1
fi

read -r -p "Désinstaller multiweb ? Les sites publiés seront conservés. [o/N] " ans
[[ "$ans" =~ ^[oOyY]$ ]] || exit 0

systemctl disable --now multiweb 2>/dev/null || true
rm -f /etc/systemd/system/multiweb.service
systemctl daemon-reload
rm -rf /opt/multiweb
rm -f /etc/multiweb.env

echo "multiweb désinstallé."
echo "Conservés : /var/www/sites, /etc/caddy/sites.d, /etc/caddy/Caddyfile, Caddy lui-même."
