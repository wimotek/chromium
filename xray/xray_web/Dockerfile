# ================= 阶段 1：Node 编译 Vue 3 前端 =================
FROM node:20-alpine AS frontend-builder
WORKDIR /build
COPY app/frontend/package*.json ./
RUN npm install
COPY app/frontend/ ./
RUN npm run build

# ================= 阶段 2：生产运行环境 (精简层数优化) =================
FROM python:3.10-slim
WORKDIR /app

# 1. 单层安装基础工具包 (补全 jq、unzip、curl、证书) 并彻底清除 apt 缓存
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# 2. 从官方 Xray 镜像提取核心二进制与路由数据
COPY --from=ghcr.io/xtls/xray-core:latest /usr/local/bin/xray /usr/bin/xray
COPY --from=ghcr.io/xtls/xray-core:latest /usr/local/share/xray/ /usr/share/xray/

# 3. 安装 Python 后端依赖
COPY app/backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r ./backend/requirements.txt

# 4. 合并拷贝代码文件与前端编译产物
COPY app/backend/ ./backend/
COPY --from=frontend-builder /build/dist ./frontend/dist
COPY config.template.json /etc/xray/config.template.json
COPY entrypoint.sh /entrypoint.sh

# 5. 设置权限与挂载
RUN chmod +x /entrypoint.sh

EXPOSE 443 3000
VOLUME ["/data"]

ENTRYPOINT ["/entrypoint.sh"]