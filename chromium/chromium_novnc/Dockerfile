# ==============================================================================
# Stage 1: Python 边缘代理依赖构建层 + 时区两文件提取 (与运行时保持同源 Debian Bookworm)
# ==============================================================================
FROM debian:bookworm-slim AS py-builder

ARG TZ=Asia/Shanghai

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    ca-certificates \
    tzdata \
    && cp "/usr/share/zoneinfo/${TZ}" /etc/localtime \
    && echo "${TZ}" > /etc/timezone \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
        "httpx>=0.27.0" \
        "websockets>=12.0" \
        --index-url https://pypi.org/simple \
        --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    && rm -rf /opt/venv/lib/python*/site-packages/pip* /opt/venv/bin/pip* \
    && find /opt/venv -type d -name "__pycache__" -prune -exec rm -rf {} + \
    && find /opt/venv -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /root/.cache

# ==============================================================================
# Stage 2: 轻量生产运行层 (dumb-init + Root-Init-Drop gosu -> UID/GID 1000)
# 构建上下文为 chromium_novnc/ (CI 构建前由 GitHub Actions 复制 edge_node_client.py)
# ==============================================================================
FROM debian:bookworm-slim

ARG PUID=1000
ARG PGID=1000
ARG TZ=Asia/Shanghai

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=${TZ} \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    DISPLAY=:0 \
    RESOLUTION=1920x1080 \
    VNC_PASSWORD= \
    CHROME_ARGS= \
    REVERSE_TUNNEL= \
    CDP_FORWARD_PORT= \
    PATH="/opt/venv/bin:${PATH}" \
    HOME=/home/appuser \
    XDG_CONFIG_HOME=/home/appuser/.config \
    XDG_CACHE_HOME=/home/appuser/.cache \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 仅提取分阶段构建产出的 2 个时区文件，不安装 tzdata 软件包
COPY --from=py-builder /etc/localtime /etc/localtime
COPY --from=py-builder /etc/timezone /etc/timezone

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    gosu \
    chromium \
    tigervnc-standalone-server \
    tigervnc-common \
    tigervnc-tools \
    openbox \
    novnc \
    websockify \
    socat \
    numlockx \
    locales \
    fonts-wqy-zenhei \
    openssl \
    ca-certificates \
    python3 \
    && echo "zh_CN.UTF-8 UTF-8" > /etc/locale.gen \
    && echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen \
    && (fc-cache -f || true) \
    && ln -f /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
    && rm -rf /var/lib/apt/lists/* \
        /var/cache/apt/* \
        /var/log/apt/* \
        /var/log/dpkg.log \
        /usr/share/doc/* \
        /usr/share/man/* \
        /usr/share/info/* \
        /usr/share/novnc/docs \
        /usr/share/novnc/tests \
        /tmp/*

RUN groupadd -g "${PGID}" appuser \
    && useradd -m -u "${PUID}" -g "${PGID}" -s /bin/bash appuser \
    && mkdir -p /data /certs /etc/ssl/app /tmp/crashpad /tmp/.X11-unix \
        /home/appuser/.vnc /home/appuser/.config /home/appuser/.cache/openbox /home/appuser/.cache/fontconfig \
    && chown -R "${PUID}:${PGID}" /data /etc/ssl/app /tmp/crashpad /home/appuser \
    && chmod 1777 /tmp /tmp/.X11-unix /tmp/crashpad

COPY --from=py-builder --chown="${PUID}:${PGID}" /opt/venv /opt/venv
COPY --chmod=755 entrypoint.sh /entrypoint.sh
COPY --chmod=755 edge_node_client.py /opt/edge_node_client.py

WORKDIR /data

ENV EDGE_WSS_PORT=9443

# 暴露端口：6080(noVNC HTTP), 6443(noVNC HTTPS), 9443(认证加密 WSS 节点直连端口；9222 仅限容器本地 127.0.0.1)
EXPOSE 6080 6443 9443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python3", "-c", "import socket, urllib.request; urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=3); socket.create_connection(('127.0.0.1', 6080), timeout=3).close()"]

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/entrypoint.sh"]
CMD []