# 使用 Node.js LTS 版本
FROM docker.io/library/node:18-slim

# 安装 Python
RUN apt-get update && apt-get install -y python3 python3-pip

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm install --registry=https://registry.npm.taobao.org

# 复制启动脚本
COPY start.sh /app/
RUN chmod +x /app/start.sh

# 复制所有源代码
COPY . .

# 暴露端口
EXPOSE 8545
EXPOSE 8000

# 启动命令
CMD ["/app/start.sh"] 