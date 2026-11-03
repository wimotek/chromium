FROM debian:bookworm-slim

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
    && echo "zh_CN.UTF-8 UTF-8" > /etc/locale.gen \
    && echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# 创建运行 Chromium 的普通非 root 用户 appuser (UID 1000)
RUN useradd -m -u 1000 -s /bin/bash appuser

# 创建工作与证书运行目录
RUN mkdir -p /data /certs /etc/ssl/app /tmp/crashpad /home/appuser/.vnc /usr/share/novnc \
    && chown -R appuser:appuser /data /certs /etc/ssl/app /tmp/crashpad /home/appuser

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /data

# 暴露端口：6080(HTTP), 6443(HTTPS), 9222(CDP 穿透端口)
EXPOSE 6080 6443 9222

# 使用 tini 接管信号与子进程回收
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# 保持原版 CMD []，完全由外部运行时传参决定
CMD []