# ================= 阶段 1：编译 Vue 3 前端 =================
FROM --platform=$BUILDPLATFORM node:20-slim AS frontend-builder
WORKDIR /build

COPY app/frontend/package*.json ./
RUN npm install --registry=https://registry.npmmirror.com

COPY app/frontend/ ./
RUN npm run build

# ================= 阶段 2：轻量主控面板生产运行环境 =================
FROM python:3.11-slim
WORKDIR /app

# 默认设置上海时区 (Asia/Shanghai, UTC+8)
ENV TZ=Asia/Shanghai

# 安装 SSH 客户端、openssl、tzdata 时区包及基础工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    openssh-client \
    openssl \
    tzdata \
    && ln -fs /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo ${TZ} > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

COPY app/backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r ./backend/requirements.txt \
    --index-url https://pypi.org/simple \
    --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple

COPY app/backend/ ./backend/
COPY --from=frontend-builder /build/dist ./frontend/dist

# 确保数据持久化目录与证书目录
RUN mkdir -p /data/keys /certs

WORKDIR /app/backend
ENV PYTHONPATH=/app/backend
ENV PYTHONUNBUFFERED=1

EXPOSE 8443
VOLUME ["/data"]

CMD ["python3", "app.py"]