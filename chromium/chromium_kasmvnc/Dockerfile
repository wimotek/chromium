# ==============================================================================
# Stage 1: 构建 Python 边缘代理依赖 + 下载 KasmVNC Release .deb (支持 amd64/arm64)
# ==============================================================================
FROM debian:bookworm-slim AS builder

ARG KASMVNC_VER=1.3.3

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    wget \
    ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
        "httpx>=0.27.0" \
        "websockets>=12.0" \
        "wimotek-edge-agent>=1.0.17" \
        --index-url https://pypi.org/simple \
        --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    && find /opt/venv -type d -name "__pycache__" -prune -exec rm -rf {} + \
    && find /opt/venv -type f -name "*.pyc" -delete \
    && ARCH="$(dpkg --print-architecture)" \
    && wget -q "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VER}/kasmvncserver_bookworm_${KASMVNC_VER}_${ARCH}.deb" -O /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/* /root/.cache

# ==============================================================================
# Stage 2: 轻量生产运行层 (dumb-init + Root-Init-Drop gosu -> UID/GID 1000)
# 构建上下文为 chromium_kasmvnc/ (CI 构建前由 GitHub Actions 复制 edge_node_client.py)
# ==============================================================================
FROM debian:bookworm-slim

ARG PUID=1000
ARG PGID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    DISPLAY=:0 \
    RESOLUTION=1920x1080 \
    VNC_PASSWORD= \
    CHROME_ARGS= \
    REVERSE_TUNNEL= \
    PATH="/opt/venv/bin:${PATH}" \
    HOME=/home/kasm-user \
    XDG_CONFIG_HOME=/home/kasm-user/.config \
    XDG_CACHE_HOME=/home/kasm-user/.cache \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY --from=builder /tmp/kasmvnc.deb /tmp/kasmvnc.deb

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    gosu \
    chromium \
    openbox \
    socat \
    numlockx \
    locales \
    fonts-wqy-zenhei \
    openssl \
    ca-certificates \
    python3 \
    libxcomposite1 \
    libxfixes3 \
    libxrandr2 \
    libxcursor1 \
    libxi6 \
    libxtst6 \
    libxinerama1 \
    ssl-cert \
    /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb \
    && echo "zh_CN.UTF-8 UTF-8" > /etc/locale.gen \
    && echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen \
    && (fc-cache -f || true) \
    && rm -rf /var/lib/apt/lists/* \
        /usr/share/doc/* \
        /usr/share/man/* \
        /usr/share/info/* \
        /tmp/*

RUN groupadd -g "${PGID}" kasm-user \
    && useradd -m -u "${PUID}" -g "${PGID}" -s /bin/bash kasm-user \
    && usermod -aG ssl-cert kasm-user \
    && mkdir -p /data /certs /etc/ssl/app /tmp/crashpad /tmp/.X11-unix \
        /home/kasm-user/.vnc /home/kasm-user/.config /home/kasm-user/.cache/openbox /home/kasm-user/.cache/fontconfig /etc/kasmvnc \
    && chown -R "${PUID}:${PGID}" /data /etc/ssl/app /tmp/crashpad /home/kasm-user /etc/kasmvnc \
    && chmod 1777 /tmp /tmp/.X11-unix /tmp/crashpad

COPY --from=builder --chown="${PUID}:${PGID}" /opt/venv /opt/venv
COPY --chmod=755 entrypoint.sh /entrypoint.sh
COPY --chmod=755 edge_node_client.py /opt/edge_node_client.py

WORKDIR /data

ENV EDGE_WSS_PORT=9443

# 暴露端口：6901(KasmVNC Web), 9443(认证加密 WSS 节点直连端口；9222 仅限容器本地 127.0.0.1)
EXPOSE 6901 9443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python3", "-c", "import socket, urllib.request; urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=3); socket.create_connection(('127.0.0.1', 6901), timeout=3).close()"]

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/entrypoint.sh"]
CMD []