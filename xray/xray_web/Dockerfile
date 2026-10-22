# 阶段 1: 编译 Vue 3 前端
FROM node:20-alpine AS frontend-builder
WORKDIR /build
COPY app/frontend/package*.json ./
RUN npm install
COPY app/frontend/ ./
RUN npm run build

# 阶段 2: 提取 Xray 核心
FROM ghcr.io/xtls/xray-core:latest AS xray-provider

# 阶段 3: 最终运行镜像
FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 复制 Xray 二进制与资源
COPY --from=xray-provider /usr/local/bin/xray /usr/local/bin/xray
COPY --from=xray-provider /usr/local/share/xray/ /usr/local/share/xray/

# 安装 Python 后端依赖
WORKDIR /app
COPY app/backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r ./backend/requirements.txt

# 复制程序代码
COPY app/backend/ ./backend/
COPY --from=frontend-builder /build/dist ./frontend/dist

# 复制配置模板与入口脚本
COPY config.template.json /config.template.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 创建数据存储挂载点
VOLUME ["/data"]

EXPOSE 443 8080

ENTRYPOINT ["/entrypoint.sh"]