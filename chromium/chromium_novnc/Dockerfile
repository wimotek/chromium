# ---- 构建阶段：装编译工具 + venv ----
FROM debian:bookworm-slim AS pydeps
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir websockets httpx wimotek-edge-agent


# ---- 最终阶段：只装运行时需要的 ---- 
FROM debian:bookworm-slim

COPY --from=pydeps /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    DISPLAY=:0 \
    RESOLUTION=1920x1080 \
    VNC_PASSWORD= \
    CHROME_ARGS=

# 安装 tini、Chromium、TigerVNC 全套工具、Openbox、noVNC、socat、gosu、numlockx 及中文字体
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
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
    curl \
    procps \
    net-tools \
    autocutsel \
    python3 \
    && echo "zh_CN.UTF-8 UTF-8" > /etc/locale.gen \
    && echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 -s /bin/bash appuser \
    && mkdir -p /data /certs /etc/ssl/app /tmp/crashpad /home/appuser/.vnc /usr/share/novnc \
    && chown -R appuser:appuser /data /certs /etc/ssl/app /tmp/crashpad /home/appuser


COPY --chmod=755 entrypoint.sh /entrypoint.sh

WORKDIR /data

# 暴露端口：6080(HTTP), 6443(HTTPS), 9222(CDP 穿透端口)
EXPOSE 6080 6443 9222

# 使用 tini 接管信号与子进程回收
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# 保持原版 CMD []，完全由外部运行时传参决定
CMD []