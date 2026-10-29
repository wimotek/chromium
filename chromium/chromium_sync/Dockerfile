# ==================== Stage 1: 构建 Vue 3 前端 ====================
FROM node:20-alpine AS frontend-builder
WORKDIR /build

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --registry=https://registry.npmmirror.com

COPY frontend/ ./
RUN npm run build

# ==================== Stage 2: 组装 Python 后端运行环境 ====================
FROM python:3.11-slim

WORKDIR /app

# 安装 SSH 客户端支持
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 拷贝后端代码及自带的 chromium_sync_module
COPY app.py .
COPY chromium_sync_module ./chromium_sync_module

# 从 Stage 1 拷贝编译生成的 Vue 3 静态页面
COPY --from=frontend-builder /build/dist ./dist

# 创建根目录 /data
RUN mkdir -p /data/keys

EXPOSE 8080
ENV DATA_DIR=/data
ENV PYTHONUNBUFFERED=1

CMD ["python", "app.py"]