#!/usr/bin/env bash
set -euo pipefail

# multiweb installer - Ubuntu 22.04 LTS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR="${MULTIWEB_INSTALL_DIR:-/opt/multiweb}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Ce script doit être lancé en root (sudo bash install.sh)" >&2
  exit 1
fi

if [ ! -f /etc/os-release ] || ! grep -q "Ubuntu" /etc/os-release; then
  echo "Avertissement : ce script est pensé pour Ubuntu. Continuer ? [o/N]"
  read -r ans
  [[ "$ans" =~ ^[oOyY]$ ]] || exit 1
fi

echo "==> multiweb : installation"
echo

NEED_CONFIG=1
if [ -f /etc/multiweb.env ]; then
  echo "/etc/multiweb.env existe déjà — la config actuelle sera conservée."
  NEED_CONFIG=0
fi

if [ "$NEED_CONFIG" -eq 1 ]; then
  read -r -p "Domaine de base (ex: apps.exemple.com) : " BASE_DOMAIN
  [ -n "$BASE_DOMAIN" ] || { echo "Domaine vide."; exit 1; }
  read -r -p "Email pour Let's Encrypt : " EMAIL
  [ -n "$EMAIL" ] || { echo "Email vide."; exit 1; }
  while :; do
    read -r -s -p "Mot de passe du dashboard : " PASSWORD; echo
    read -r -s -p "Confirmer : " PASSWORD2; echo
    [ "$PASSWORD" = "$PASSWORD2" ] && [ -n "$PASSWORD" ] && break
    echo "Les mots de passe ne correspondent pas (ou sont vides). Réessayez."
  done
fi

echo
echo "==> Mise à jour des paquets…"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  curl ca-certificates unzip gnupg apt-transport-https \
  debian-keyring debian-archive-keyring

echo "==> Installation de Caddy si nécessaire…"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
fi

echo "==> Installation de Bun si nécessaire…"
if ! command -v bun >/dev/null 2>&1; then
  export BUN_INSTALL=/usr/local
  curl -fsSL https://bun.sh/install | bash
fi

if [ ! -x /usr/local/bin/bun ]; then
  echo "Bun introuvable dans /usr/local/bin/bun." >&2
  exit 1
fi

echo "==> Copie du code dans $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .env --exclude '*.log' \
  "$REPO_ROOT/server/" "$INSTALL_DIR/server/"
cp "$SCRIPT_DIR/multiweb.service" "$INSTALL_DIR/multiweb.service"
cp "$SCRIPT_DIR/Caddyfile.template" "$INSTALL_DIR/Caddyfile.template"

echo "==> Création des dossiers de runtime…"
mkdir -p /var/www/sites

if [ "$NEED_CONFIG" -eq 1 ]; then
  echo "==> Génération du Caddyfile…"
  sed \
    -e "s/__EMAIL__/${EMAIL//\//\\/}/g" \
    -e "s/__BASE_DOMAIN__/${BASE_DOMAIN//\//\\/}/g" \
    "$SCRIPT_DIR/Caddyfile.template" > /etc/caddy/Caddyfile

  echo "==> Écriture de /etc/multiweb.env…"
  umask 077
  cat > /etc/multiweb.env <<EOF
MULTIWEB_PASSWORD=$PASSWORD
MULTIWEB_BASE_DOMAIN=$BASE_DOMAIN
MULTIWEB_EMAIL=$EMAIL
EOF
  chmod 600 /etc/multiweb.env
fi

echo "==> Configuration du service systemd…"
cp "$SCRIPT_DIR/multiweb.service" /etc/systemd/system/multiweb.service
systemctl daemon-reload
systemctl enable multiweb >/dev/null 2>&1 || true
systemctl enable caddy >/dev/null 2>&1 || true

echo "==> (Re)démarrage des services…"
systemctl restart caddy
systemctl restart multiweb
sleep 1

echo
if systemctl is-active --quiet multiweb && systemctl is-active --quiet caddy; then
  source /etc/multiweb.env
  echo "------------------------------------------------------------"
  echo " multiweb est en ligne."
  echo
  echo "  Dashboard  : https://dash.$MULTIWEB_BASE_DOMAIN"
  echo "  Sites      : https://<nom>.$MULTIWEB_BASE_DOMAIN"
  echo
  echo " Vérifiez votre DNS : un wildcard *.$MULTIWEB_BASE_DOMAIN"
  echo " doit pointer vers cette machine pour que le HTTPS auto"
  echo " fonctionne. (Ou bien ajoutez chaque sous-domaine à la main.)"
  echo
  echo " Logs        : journalctl -u multiweb -f"
  echo " Restart     : systemctl restart multiweb"
  echo "------------------------------------------------------------"
else
  echo "Quelque chose ne va pas. Vérifie :"
  echo "  systemctl status multiweb"
  echo "  systemctl status caddy"
  echo "  journalctl -u multiweb -n 50"
  exit 1
fi
