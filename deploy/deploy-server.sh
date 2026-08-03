#!/usr/bin/env bash
# 旅游攻略协作应用 —— 云服务器一键部署脚本（Ubuntu/Debian 或 CentOS/RHEL）
# 用法：在服务器上以 root 或 sudo 用户执行  bash deploy-server.sh
# 重复执行可安全更新代码（data/rooms.json 协作数据会被保留）。
set -euo pipefail

# ====== 可配置 ======
CLONE_URL="https://github.com/AdminGithub128/travel-planner.git"
BRANCH="main"
APP_DIR="/opt/travel-planner"
PORT="3000"
# ====================

echo "[1/5] 安装 Node.js 20 LTS 与 git ..."
if command -v apt-get >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
  sudo apt-get install -y nodejs git
elif command -v dnf >/dev/null 2>&1; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
  sudo dnf install -y nodejs git
else
  echo "❌ 不支持的系统（需 apt 或 dnf 包管理器）"; exit 1
fi
echo "✅ node: $(node -v)  npm: $(npm -v)"

echo "[2/5] 拉取/更新代码到 $APP_DIR ..."
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  sudo git fetch --depth 1 origin "$BRANCH"
  sudo git reset --hard "origin/$BRANCH"   # gitignored 的 data/rooms.json 不会被删，协作数据保留
else
  sudo rm -rf "$APP_DIR"
  sudo git clone --depth 1 -b "$BRANCH" "$CLONE_URL" "$APP_DIR"
fi

echo "[3/5] 写入 systemd 服务 ..."
sudo tee /etc/systemd/system/travel-planner.service >/dev/null <<EOF
[Unit]
Description=Travel Planner (Node)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "[4/5] 启动并设为开机自启 ..."
sudo systemctl daemon-reload
sudo systemctl enable --now travel-planner
sleep 2
sudo systemctl status travel-planner --no-pager -l | head -15 || true

echo "[5/5] 完成 ✅"
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "访问地址：http://$SERVER_IP:$PORT/#macau-2026"
echo ""
echo "⚠️  请在云控制台「安全组/防火墙」放行 $PORT 端口（TCP 入站）。"
echo "📝 查看日志：sudo journalctl -u travel-planner -f"
echo "🔄 以后更新代码：bash deploy-server.sh  （协作数据会保留）"
