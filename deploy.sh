#!/usr/bin/env bash
set -euo pipefail

echo "=== Deploying -d Bot & Portal ==="

# 1. Install Node.js 20 LTS if missing (Debian/Ubuntu)
if ! command -v node >/dev/null 2>&1; then
  echo "[1/5] Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[1/5] Node.js found: $(node -v)"
fi

# 2. Install Chromium shared libraries for Puppeteer if on apt-based Linux
if command -v apt-get >/dev/null 2>&1; then
  echo "[2/5] Installing Chromium dependencies for Puppeteer..."
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils || true
fi

# 3. Install npm packages
echo "[3/5] Installing npm dependencies..."
npm install --no-audit --no-fund

# 4. Prepare .env if not present
if [ ! -f .env ]; then
  echo "[4/5] Creating .env from .env.example..."
  cp .env.example .env
  if [ -n "${BOT_TOKEN:-}" ]; then
    sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=${BOT_TOKEN}|" .env
  else
    read -r -p "Masukkan BOT_TOKEN dari @BotFather: " INPUT_TOKEN
    sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=${INPUT_TOKEN}|" .env
  fi
else
  echo "[4/5] .env already exists, skipping."
fi

# 5. Install PM2 and start permanently
echo "[5/5] Starting bot & portal with PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2 || npm install -g pm2
fi

pm2 delete doodstream-bot >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup | tail -n 1 | bash || true

echo "=== Selesai! ==="
echo "Cek status : pm2 status"
echo "Cek log    : pm2 logs doodstream-bot"
