FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    DISPLAY=:0 \
    RESOLUTION=1920x1080 \
    VNC_PASSWORD= \
    CHROME_ARGS=

# 安装 Chromium、TigerVNC Standalone (自带 X Server)、Openbox、noVNC、socat 及核心工具
# 包含 numlockx (解决小键盘锁定) 与 locales (确保 UTF-8 剪贴板完全不乱码)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    tigervnc-standalone-server \
    tigervnc-common \
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

# 创建运行目录
RUN mkdir -p /data /certs /etc/ssl/app /tmp/crashpad /root/.vnc /usr/share/novnc

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /data

# 暴露端口：6080(HTTP), 6443(HTTPS), 9222(CDP 穿透端口)
EXPOSE 6080 6443 9222

ENTRYPOINT ["/entrypoint.sh"]