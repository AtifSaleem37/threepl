#!/usr/bin/env bash
# EC2 setup script for 3PL Prep Portal
# Run as: sudo bash setup.sh
# Tested on Ubuntu 22.04 / 24.04

set -euo pipefail

APP_DIR="/home/ubuntu/threepl"
REPO="https://github.com/AtifSaleem37/threepl.git"
SERVICE_NAME="threepl"
NODE_MAJOR=22

echo "==> [1/7] System update"
apt-get update -y && apt-get upgrade -y

echo "==> [2/7] Install dependencies (Node $NODE_MAJOR, nginx, certbot, git, sqlite3)"
apt-get install -y curl git nginx certbot python3-certbot-nginx sqlite3 ufw

# Install Node via NodeSource
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(+process.version.slice(1).split(\".\")[0] < '"$NODE_MAJOR"')')" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
  apt-get install -y nodejs
fi

echo "Node $(node -v)  |  npm $(npm -v)"

echo "==> [3/7] Clone / update repo"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
chown -R ubuntu:ubuntu "$APP_DIR"

echo "==> [4/7] Install npm packages"
su - ubuntu -c "cd $APP_DIR && npm ci --omit=dev"

echo "==> [5/7] Configure .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Generate a random session secret
  SECRET=$(openssl rand -hex 32)
  sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$SECRET/" "$APP_DIR/.env"
  echo ""
  echo "  !! .env created from .env.example"
  echo "  !! Edit $APP_DIR/.env before starting the service:"
  echo "     - ADMIN_PASSWORD"
  echo "     - SMTP_USER / SMTP_PASS (optional)"
  echo "     - COMPANY_* fields"
  echo ""
else
  echo "  .env already exists — skipping"
fi

echo "==> [6/7] Install & enable systemd service"
cp "$APP_DIR/deploy/threepl.service" /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
echo "  Service status: $(systemctl is-active $SERVICE_NAME)"

echo "==> [7/7] Configure nginx"
# Prompt for domain
read -rp "  Enter your domain (e.g. portal.example.com) or press Enter to skip HTTPS setup: " DOMAIN

cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/$SERVICE_NAME
ln -sf /etc/nginx/sites-available/$SERVICE_NAME /etc/nginx/sites-enabled/$SERVICE_NAME
rm -f /etc/nginx/sites-enabled/default

if [ -n "$DOMAIN" ]; then
  sed -i "s/server_name .*/server_name $DOMAIN;/" /etc/nginx/sites-available/$SERVICE_NAME
  nginx -t && systemctl reload nginx

  # Open firewall
  ufw allow OpenSSH
  ufw allow 'Nginx Full'
  ufw --force enable

  echo "  Running certbot for $DOMAIN ..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
else
  # No domain — serve on port 80 using the EC2 public IP
  PUBLIC_IP=$(curl -sf http://169.254.169.254/latest/meta-data/public-ipv4 || echo "_")
  sed -i "s/server_name .*/server_name $PUBLIC_IP;/" /etc/nginx/sites-available/$SERVICE_NAME

  ufw allow OpenSSH
  ufw allow 'Nginx HTTP'
  ufw --force enable

  nginx -t && systemctl reload nginx
  echo "  Serving on http://$PUBLIC_IP"
fi

echo ""
echo "=============================="
echo " 3PL Portal setup complete!"
echo " App dir : $APP_DIR"
echo " Service : systemctl status $SERVICE_NAME"
echo " Logs    : journalctl -u $SERVICE_NAME -f"
echo "=============================="
