FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 优化策略：
# 1. 安装基础依赖、Chromium、Openbox、文泉驿中文字体与 gosu 权限管理工具
# 2. 补齐 KasmVNC 运行依赖 (hostname、libdatetime-perl 等)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    openbox \
    fonts-wqy-zenhei \
    socat \
    openssl \
    tini \
    gosu \
    curl \
    ca-certificates \
    x11-xkb-utils \
    xauth \
    libxfont2 \
    libxshmfence1 \
    libwebp7 \
    libjpeg62-turbo \
    hostname \
    libdatetime-perl \
    libhash-merge-simple-perl \
    libyaml-tiny-perl \
    && rm -rf /var/lib/apt/lists/*

# 自动根据当前 CPU 架构 (amd64 / arm64) 下载安装 KasmVNC 官方稳定版
RUN ARCH=$(dpkg --print-architecture) && \
    curl -LO "https://github.com/kasmtech/KasmVNC/releases/download/v1.3.3/kasmvncserver_bookworm_1.3.3_${ARCH}.deb" && \
    apt-get update && \
    apt-get install -y --no-install-recommends ./kasmvncserver_bookworm_1.3.3_${ARCH}.deb && \
    rm -f ./kasmvncserver_bookworm_1.3.3_${ARCH}.deb && \
    rm -rf /var/lib/apt/lists/*

# 创建非特权用户 appuser (UID 1000) 及必要目录
RUN useradd -m -u 1000 -s /bin/bash appuser && \
    usermod -aG ssl-cert appuser && \
    mkdir -p /data /home/appuser/.vnc /tmp/.X11-unix /certs && \
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix /certs && \
    chmod 1777 /tmp/.X11-unix

WORKDIR /home/appuser

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 暴露端口：8444(KasmVNC HTTPS), 9222(CDP 自动化调试)
EXPOSE 8444 9222

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD []
