# ================= 阶段 1：编译 Vue 3 SaaS 前端 =================
FROM --platform=$BUILDPLATFORM node:20-slim AS frontend-builder
WORKDIR /build

COPY app/frontend/package*.json ./
RUN npm install --no-audit --no-fund

COPY app/frontend/ ./
RUN npm run build

# ================= 阶段 2：编译隔离 Python 运行环境 + 后端二进制闭源构建 =================
FROM python:3.11-slim-bookworm AS backend-builder
WORKDIR /build

ARG TZ=Asia/Shanghai

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

COPY app/backend/requirements.txt ./requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    build-essential \
    binutils \
    && cp "/usr/share/zoneinfo/${TZ}" /etc/localtime \
    && echo "${TZ}" > /etc/timezone \
    && python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r ./requirements.txt \
        --index-url https://pypi.org/simple \
        --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    && /opt/venv/bin/pip install --no-cache-dir --target /opt/build-tools \
        "cython>=3.0,<3.2" "setuptools>=68" wheel \
        --index-url https://pypi.org/simple \
        --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

COPY app/backend/ /build/src_backend/

RUN PYTHONPATH=/opt/build-tools /opt/venv/bin/python /build/src_backend/build_binary.py \
        --src /build/src_backend \
        --out /build/backend_bin \
        --bin-name chromium-sync-saas \
    && DATA_DIR=/tmp/saas_selftest /build/backend_bin/chromium-sync-saas --self-test \
    && rm -rf /tmp/saas_selftest /opt/build-tools /build/src_backend \
    && rm -rf /opt/venv/lib/python*/site-packages/pip* /opt/venv/bin/pip* \
    && find /opt/venv -type d -name "__pycache__" -prune -exec rm -rf {} + \
    && find /opt/venv -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete

# ================= 阶段 3：闭源二进制生产运行镜像 (dumb-init + Root-Init-Drop gosu) =================
FROM python:3.11-slim-bookworm

ARG PUID=1000
ARG PGID=1000
ARG TZ=Asia/Shanghai

WORKDIR /app

ENV TZ=${TZ} \
    HUB_HOST=:: \
    HUB_PORT=8443 \
    PATH="/opt/venv/bin:${PATH}" \
    PYTHONPATH=/app/backend \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY --from=backend-builder /etc/localtime /etc/localtime
COPY --from=backend-builder /etc/timezone /etc/timezone

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    gosu \
    ca-certificates \
    openssl \
    && rm -rf /var/lib/apt/lists/* \
        /var/cache/apt/* \
        /var/log/apt/* \
        /var/log/dpkg.log \
        /usr/share/doc/* \
        /usr/share/man/* \
        /usr/share/info/* \
        /tmp/* \
    && groupadd -g "${PGID}" hubuser \
    && useradd -m -u "${PUID}" -g "${PGID}" -s /bin/bash hubuser \
    && mkdir -p /data/certs /certs /etc/ssl/app /app/backend /app/frontend/dist \
    && chown -R "${PUID}:${PGID}" /data /etc/ssl/app /app

COPY --from=backend-builder --chown="${PUID}:${PGID}" /opt/venv /opt/venv
COPY --from=frontend-builder --chown="${PUID}:${PGID}" /build/dist /app/frontend/dist
COPY --from=backend-builder --chown="${PUID}:${PGID}" /build/backend_bin /app/backend
COPY --chmod=755 entrypoint.sh /entrypoint.sh

RUN python3 -c "import urllib.request; urls=['https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat','https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat']; [urllib.request.urlretrieve(u, '/app/geoip.dat') for u in urls[:1]]" \
    || python3 -c "import urllib.request; urllib.request.urlretrieve('https://cdn.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat', '/app/geoip.dat')" \
    || true \
    && ([ -f /app/geoip.dat ] && chown "${PUID}:${PGID}" /app/geoip.dat || true)

WORKDIR /app/backend

EXPOSE ${HUB_PORT}
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["sh", "-c", "python3 -c \"import os, ssl, urllib.request; p = os.getenv('HUB_PORT') or '8443'; fe = (os.getenv('HUB_SERVE_FRONTEND') or 'true').strip().lower() not in ('0','false','no','off'); sch = 'https' if fe else 'http'; ctx = ssl._create_unverified_context() if fe else None; urllib.request.urlopen(f'{sch}://127.0.0.1:{p}/api/auth/status', context=ctx, timeout=3)\" || python3 -c \"import os, ssl, urllib.request; p = os.getenv('HUB_PORT') or '8443'; fe = (os.getenv('HUB_SERVE_FRONTEND') or 'true').strip().lower() not in ('0','false','no','off'); sch = 'https' if fe else 'http'; ctx = ssl._create_unverified_context() if fe else None; urllib.request.urlopen(f'{sch}://[::1]:{p}/api/auth/status', context=ctx, timeout=3)\""]

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/entrypoint.sh"]
CMD ["/app/backend/chromium-sync-saas"]
