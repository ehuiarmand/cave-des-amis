#!/bin/bash
# Script d'installation automatique - TDB Bar
set -e

echo ""
echo "================================================"
echo "  Installation TDB Bar sur VPS"
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
echo "[4/6] Creation du dossier /opt/tdb-bar..."
mkdir -p /opt/tdb-bar
mkdir -p /root/.cloudflared

# Service systemd pour le serveur Python
echo "[5/6] Creation du service TDB Bar..."
cat > /etc/systemd/system/tdb-bar.service << 'EOF'
[Unit]
Description=TDB Bar - Gestion Cave
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/tdb-bar
Environment=TDB_BAR_PORT=8000
ExecStart=/usr/bin/python3 server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Service systemd pour cloudflared
echo "[6/6] Creation du service Cloudflare Tunnel..."
cat > /etc/systemd/system/tdb-tunnel.service << 'EOF'
[Unit]
Description=TDB Bar - Cloudflare Tunnel
After=network.target tdb-bar.service

[Service]
Type=simple
User=root
ExecStart=/usr/bin/cloudflared tunnel --config /opt/tdb-bar/cloudflared-vps.yml run tdb-bar
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tdb-bar
systemctl enable tdb-tunnel

echo ""
echo "================================================"
echo "  Installation terminee !"
echo "  Copiez maintenant vos fichiers puis lancez :"
echo "  systemctl start tdb-bar tdb-tunnel"
echo "================================================"
echo ""
