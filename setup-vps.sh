#!/bin/bash
# Script d'installation automatique - Maquis Manager
set -e

APP_DIR="/opt/maquis-manager"
SERVICE_APP="maquis-manager"
SERVICE_TUNNEL="maquis-manager-tunnel"

echo ""
echo "================================================"
echo "  Installation Maquis Manager sur VPS"
echo "================================================"
echo ""

# Mise a jour du systeme
echo "[1/6] Mise a jour du systeme..."
apt update && apt upgrade -y

# Installation Python
echo "[2/6] Installation Python..."
apt install -y python3 python3-pip

# Installation cloudflared
echo "[3/6] Installation cloudflared..."
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb
rm cloudflared.deb

# Creation du dossier de l'application
echo "[4/6] Creation du dossier ${APP_DIR}..."
mkdir -p "${APP_DIR}"
mkdir -p /root/.cloudflared

# Service systemd pour le serveur Python
echo "[5/6] Creation du service Maquis Manager..."
cat > /etc/systemd/system/${SERVICE_APP}.service << EOF
[Unit]
Description=Maquis Manager - Gestion maquis / cave
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
Environment=MAQUIS_MANAGER_PORT=8000
ExecStart=/usr/bin/python3 server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Service systemd pour cloudflared
echo "[6/6] Creation du service Cloudflare Tunnel..."
cat > /etc/systemd/system/${SERVICE_TUNNEL}.service << EOF
[Unit]
Description=Maquis Manager - Cloudflare Tunnel
After=network.target ${SERVICE_APP}.service

[Service]
Type=simple
User=root
ExecStart=/usr/bin/cloudflared tunnel --config ${APP_DIR}/cloudflared-vps.yml run maquis-manager
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_APP}"
systemctl enable "${SERVICE_TUNNEL}"

echo ""
echo "================================================"
echo "  Installation terminee !"
echo "  Creez un tunnel Cloudflare nomme \"maquis-manager\" puis copiez vos fichiers dans ${APP_DIR}"
echo "  Lancez : systemctl start ${SERVICE_APP} ${SERVICE_TUNNEL}"
echo "================================================"
echo ""
