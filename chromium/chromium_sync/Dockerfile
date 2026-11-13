# ================= 阶段 1：编译 Vue 3 前端 =================
FROM --platform=$BUILDPLATFORM node:20-slim AS frontend-builder
WORKDIR /build

COPY app/frontend/package*.json ./
RUN npm install --registry=https://registry.npmmirror.com

COPY app/frontend/ ./
RUN npm run build

# ================= 阶段 2：编译隔离 Python 虚拟环境 =================
FROM python:3.11-slim-bookworm AS backend-builder
WORKDIR /build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

COPY app/backend/requirements.txt ./requirements.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r ./requirements.txt \
        --index-url https://pypi.org/simple \
        --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    && find /opt/venv -type d -name "__pycache__" -prune -exec rm -rf {} + \
    && find /opt/venv -type f -name "*.pyc" -delete

# ================= 阶段 3：轻量主控面板生产运行环境 (dumb-init + Root-Init-Drop gosu) =================
FROM python:3.11-slim-bookworm

ARG PUID=1000
ARG PGID=1000

WORKDIR /app

ENV TZ=Asia/Shanghai \
    HUB_HOST=:: \
    HUB_PORT=8443 \
    PATH="/opt/venv/bin:${PATH}" \
    PYTHONPATH=/app/backend \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 安装 dumb-init、gosu、SSH 客户端、openssl、tzdata 并清理文档缓存
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    gosu \
    ca-certificates \
    openssh-client \
    openssl \
    tzdata \
    && ln -fs "/usr/share/zoneinfo/${TZ}" /etc/localtime \
    && echo "${TZ}" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/* \
        /usr/share/doc/* \
        /usr/share/man/* \
        /usr/share/info/* \
        /tmp/*

RUN groupadd -g "${PGID}" hubuser \
    && useradd -m -u "${PUID}" -g "${PGID}" -s /bin/bash hubuser \
    && mkdir -p /data/keys /data/certs /certs /etc/ssl/app /app/backend /app/frontend \
    && chown -R "${PUID}:${PGID}" /data /etc/ssl/app /app

COPY --from=backend-builder --chown="${PUID}:${PGID}" /opt/venv /opt/venv
COPY --chown="${PUID}:${PGID}" app/backend/ ./backend/
COPY --from=frontend-builder --chown="${PUID}:${PGID}" /build/dist ./frontend/dist
COPY --chmod=755 entrypoint.sh /entrypoint.sh

WORKDIR /app/backend

EXPOSE ${HUB_PORT}
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["sh", "-c", "python3 -c \"import os, ssl, urllib.request; p = os.getenv('HUB_PORT') or '8443'; urllib.request.urlopen(f'https://127.0.0.1:{p}/api/auth/status', context=ssl._create_unverified_context(), timeout=3)\" || python3 -c \"import os, ssl, urllib.request; p = os.getenv('HUB_PORT') or '8443'; urllib.request.urlopen(f'https://[::1]:{p}/api/auth/status', context=ssl._create_unverified_context(), timeout=3)\""]

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/entrypoint.sh"]
CMD ["python3", "app.py"]