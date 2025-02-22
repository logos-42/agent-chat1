#!/bin/bash

# 清理可能存在的进程
cleanup() {
    echo "清理进程..."
    kill $(jobs -p) 2>/dev/null
    exit 0
}

# 设置清理钩子
trap cleanup SIGINT SIGTERM

# 启动 hardhat 节点
echo "启动本地区块链节点..."
npx hardhat node &
sleep 5

# 部署合约和启动对话系统
echo "部署合约和启动对话系统..."
npx hardhat run scripts/agent_chat.js --network localhost &
sleep 2

# 启动前端服务器
echo "启动前端服务器..."
cd frontend && python3 -m http.server 8000 &

# 等待所有后台进程
wait 