# ==================== Stage 1: Vue 3 前端自动编译 ====================
FROM node:20-alpine AS frontend-builder
WORKDIR /build

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --registry=https://registry.npmmirror.com

COPY frontend/ ./
RUN npm run build

# ==================== Stage 2: Python 后端运行环境 ====================
FROM python:3.11-slim

WORKDIR /app

# 安装 SSH 客户端、openssl（自签名证书生成）与基础工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 拷贝后端入口
COPY app.py .

# 从 Stage 1 拷贝编译好的前端静态资源
COPY --from=frontend-builder /build/dist ./dist

# 初始化数据与证书目录
RUN mkdir -p /data/keys /certs

EXPOSE 8443
ENV PYTHONUNBUFFERED=1

CMD ["python", "app.py"]