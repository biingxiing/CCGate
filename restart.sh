#!/bin/bash

# CCGate 服务重启脚本
# 用法: ./restart.sh

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # 无颜色

echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}   CCGate 服务重启工具${NC}"
echo -e "${BLUE}================================${NC}"

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="CCGate"

# 切换到项目目录
cd "$SCRIPT_DIR"

echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] 开始重启 CCGate 服务...${NC}"

# 查找运行中的服务进程
echo -e "${BLUE}正在查找运行中的服务进程...${NC}"

# 查找包含 server.js 的 node 进程，且路径包含 CCGate
PIDS=$(ps aux | grep "node.*server\.js" | grep -i "ccgate" | grep -v grep | awk '{print $2}')

# 如果没找到，尝试查找包含当前路径的 node 进程
if [ -z "$PIDS" ]; then
    PIDS=$(ps aux | grep "node.*server\.js" | grep "$SCRIPT_DIR" | grep -v grep | awk '{print $2}')
fi

# 如果还没找到，查找所有包含 server.js 的进程
if [ -z "$PIDS" ]; then
    PIDS=$(ps aux | grep "server\.js" | grep -v grep | awk '{print $2}')
fi

if [ -z "$PIDS" ]; then
    echo -e "${YELLOW}没有找到运行中的服务进程${NC}"
else
    echo -e "${GREEN}找到以下进程:${NC}"
    for PID in $PIDS; do
        echo -e "  PID: ${GREEN}$PID${NC}"
        ps -p "$PID" -o pid,ppid,cmd --no-headers 2>/dev/null || echo "    进程已不存在"
    done
    
    # 逐个终止进程
    for PID in $PIDS; do
        if kill -0 "$PID" 2>/dev/null; then
            echo -e "${YELLOW}正在停止进程 $PID...${NC}"
            kill -TERM "$PID"
            
            # 等待进程优雅退出
            sleep 3
            
            # 检查进程是否还在运行
            if kill -0 "$PID" 2>/dev/null; then
                echo -e "${RED}进程 $PID 未响应 SIGTERM，使用 SIGKILL 强制终止...${NC}"
                kill -KILL "$PID"
                sleep 1
            fi
            
            echo -e "${GREEN}进程 $PID 已停止${NC}"
        fi
    done
fi

# 确保所有相关进程都已停止
sleep 2

# 检查是否还有残留进程
REMAINING=$(ps aux | grep "server\.js" | grep -v grep | wc -l)
if [ "$REMAINING" -gt 0 ]; then
    echo -e "${YELLOW}警告: 仍有 $REMAINING 个相关进程在运行${NC}"
fi

echo -e "${BLUE}正在启动新的服务实例...${NC}"

# 备份并清空当前的 nohup.log（如果存在且大于10MB）
if [ -f "nohup.log" ] && [ $(stat -f%z nohup.log 2>/dev/null || stat -c%s nohup.log 2>/dev/null || echo 0) -gt 10485760 ]; then
    echo -e "${YELLOW}备份大日志文件...${NC}"
    mv nohup.log "nohup.log.$(date +%Y%m%d_%H%M%S).bak"
fi

# 添加重启时间戳到日志
echo "" >> nohup.log
echo "=== CCGate 服务重启于 $(date '+%Y-%m-%d %H:%M:%S') ===" >> nohup.log

# 启动服务
nohup pnpm start >> nohup.log 2>&1 &
NEW_PID=$!

sleep 2

# 检查新进程是否成功启动
if kill -0 "$NEW_PID" 2>/dev/null; then
    echo -e "${GREEN}✓ 服务启动成功!${NC}"
    echo -e "  主进程 PID: ${GREEN}$NEW_PID${NC}"
    
    # 尝试找到实际的 node 进程
    sleep 2
    NODE_PID=$(ps aux | grep "node.*server\.js" | grep -v grep | awk '{print $2}' | head -1)
    if [ -n "$NODE_PID" ] && [ "$NODE_PID" != "$NEW_PID" ]; then
        echo -e "  Node 进程 PID: ${GREEN}$NODE_PID${NC}"
    fi
    
    echo -e "${BLUE}日志文件: $(pwd)/nohup.log${NC}"
    
    # 简单的健康检查（如果配置了health端点）
    sleep 3
    echo -e "${BLUE}正在进行健康检查...${NC}"
    if command -v curl > /dev/null 2>&1; then
        if curl -s -f http://localhost:3000/health > /dev/null 2>&1; then
            echo -e "${GREEN}✓ 健康检查通过${NC}"
        else
            echo -e "${YELLOW}⚠ 健康检查失败，服务可能还在初始化中...${NC}"
        fi
    else
        echo -e "${YELLOW}⚠ 未安装 curl，跳过健康检查${NC}"
    fi
    
else
    echo -e "${RED}✗ 服务启动失败!${NC}"
    echo -e "${YELLOW}请检查日志文件: $(pwd)/nohup.log${NC}"
    exit 1
fi

echo -e "${BLUE}================================${NC}"
echo -e "${GREEN}重启完成! 使用以下命令查看日志:${NC}"
echo -e "  tail -f nohup.log"
echo -e "${BLUE}================================${NC}"