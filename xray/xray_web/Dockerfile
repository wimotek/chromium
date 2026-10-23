# ================= 阶段 1：编译 Vue 3 前端 (改用 Debian glibc 核心，单层拷贝，绝不崩溃) =================
FROM node:20-slim AS frontend-builder
WORKDIR /build

COPY app/frontend/package*.json ./
RUN npm install

# 恢复单层拷贝，保持层数最精简
COPY app/frontend/ ./
RUN npm run build

# ================= 阶段 2：生产运行环境 =================
FROM python:3.10-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/xtls/xray-core:latest /usr/local/bin/xray /usr/bin/xray
COPY --from=ghcr.io/xtls/xray-core:latest /usr/local/share/xray/ /usr/share/xray/

COPY app/backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r ./backend/requirements.txt

COPY app/backend/ ./backend/
COPY --from=frontend-builder /build/dist ./frontend/dist
COPY config.template.json /etc/xray/config.template.json
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

EXPOSE 443 3000
VOLUME ["/data"]

ENTRYPOINT ["/entrypoint.sh"]