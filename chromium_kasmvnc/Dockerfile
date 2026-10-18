FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 安装基础依赖、Chromium、Openbox、文泉驿中文字体与工具
# 此处已补齐 KasmVNC 所需的 Perl 模块 (libdatetime-perl 等) 与 hostname
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    openbox \
    fonts-wqy-zenhei \
    socat \
    openssl \
    tini \
    curl \
    ca-certificates \
    x11-xkb-utils \
    xauth \
    libxfont2 \
    libxshmfence1 \
    libwebp7 \
    libjpeg62-turbo \
    sudo \
    hostname \
    libdatetime-perl \
    libhash-merge-simple-perl \
    libyaml-tiny-perl \
    && rm -rf /var/lib/apt/lists/*

# 自动根据当前 CPU 架构 (amd64 / arm64) 下载安装 KasmVNC 官方稳定包
RUN ARCH=$(dpkg --print-architecture) && \
    curl -LO "https://github.com/kasmtech/KasmVNC/releases/download/v1.3.3/kasmvncserver_bookworm_1.3.3_${ARCH}.deb" && \
    apt-get update && \
    apt-get install -y --no-install-recommends ./kasmvncserver_bookworm_1.3.3_${ARCH}.deb && \
    rm -f ./kasmvncserver_bookworm_1.3.3_${ARCH}.deb && \
    rm -rf /var/lib/apt/lists/*

# 创建非 root 运行用户
RUN useradd -m -u 1000 -s /bin/bash appuser && \
    usermod -aG ssl-cert appuser && \
    mkdir -p /data /home/appuser/.vnc && \
    chown -R appuser:appuser /data /home/appuser

WORKDIR /home/appuser

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 暴露端口：8444(Web HTTPS), 9222(CDP)
EXPOSE 8444 9222

USER appuser

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD []
