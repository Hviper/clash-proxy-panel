#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT=3690

# Check if node is available
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed or not in PATH."
  exit 1
fi

# Check if node_modules exists, otherwise install
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "=================================================="
echo "⚡ ProxyPort Mesh - Clash 代理组与独立端口管理面板"
echo "=================================================="
echo "服务正在启动..."
echo "控制台网址: http://127.0.0.1:$PORT"
echo "按 Ctrl+C 可停止服务"
echo "=================================================="

exec node server.js
