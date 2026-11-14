# ==============================================================================
# Stage 1: 构建 Python 边缘代理依赖 + 时区两文件提取 + 下载 KasmVNC Release .deb (支持 amd64/arm64)
# ==============================================================================
FROM debian:bookworm-slim AS builder

ARG KASMVNC_VER=1.3.3
ARG TZ=Asia/Shanghai

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    wget \
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
    && ARCH="$(dpkg --print-architecture)" \
    && wget -q "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VER}/kasmvncserver_bookworm_${KASMVNC_VER}_${ARCH}.deb" -O /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /root/.cache

# ==============================================================================
# Stage 2: 轻量生产运行层 (dumb-init + Root-Init-Drop gosu -> UID/GID 1000)
# 构建上下文为 chromium_kasmvnc/ (CI 构建前由 GitHub Actions 复制 common/edge_node_client.py 与 common/desktop/)
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
    HOME=/home/kasm-user \
    XDG_CONFIG_HOME=/home/kasm-user/.config \
    XDG_CACHE_HOME=/home/kasm-user/.cache \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 仅提取分阶段构建产出的 2 个时区文件，不安装 tzdata 软件包
COPY --from=builder /etc/localtime /etc/localtime
COPY --from=builder /etc/timezone /etc/timezone
COPY --from=builder /tmp/kasmvnc.deb /tmp/kasmvnc.deb

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    gosu \
    chromium \
    openbox \
    tint2 \
    xterm \
    autocutsel \
    xclip \
    librsvg2-common \
    x11-xserver-utils \
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
        /var/cache/apt/* \
        /var/log/apt/* \
        /var/log/dpkg.log \
        /usr/share/doc/* \
        /usr/share/man/* \
        /usr/share/info/* \
        /tmp/*

# 定制化 Openbox (Wimotek-Dark) + tint2 底部工具栏 + 快捷脚本
COPY desktop/openbox/ /etc/xdg/openbox/
COPY desktop/themes/Wimotek-Dark/ /usr/share/themes/Wimotek-Dark/
COPY desktop/tint2/tint2rc /etc/xdg/tint2/tint2rc
COPY desktop/applications/ /usr/share/applications/
COPY desktop/icons/ /usr/share/icons/wimotek/
COPY --chmod=755 desktop/bin/ /usr/local/bin/

RUN groupadd -g "${PGID}" kasm-user \
    && useradd -m -u "${PUID}" -g "${PGID}" -s /bin/bash kasm-user \
    && usermod -aG ssl-cert kasm-user \
    && mkdir -p /data /certs /etc/ssl/app /tmp/crashpad /tmp/.X11-unix \
        /home/kasm-user/.vnc /home/kasm-user/.config/openbox /home/kasm-user/.config/tint2 \
        /home/kasm-user/.cache/openbox /home/kasm-user/.cache/fontconfig /etc/kasmvnc \
    && cp /etc/xdg/openbox/rc.xml /etc/xdg/openbox/menu.xml /home/kasm-user/.config/openbox/ \
    && cp /etc/xdg/tint2/tint2rc /home/kasm-user/.config/tint2/tint2rc \
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