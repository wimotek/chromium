FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    DISPLAY=:1 \
    RESOLUTION=1920x1080 \
    VNC_USER=admin \
    VNC_PASSWORD=admin \
    CHROME_ARGS=

# 1. 严格保留 tini 作为 init 进程
#    安装 Chromium、Openbox、socat、numlockx (小键盘锁定)、中文字体及运行库
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    chromium \
    openbox \
    socat \
    numlockx \
    locales \
    fonts-wqy-zenhei \
    openssl \
    ca-certificates \
    curl \
    wget \
    procps \
    net-tools \
    sudo \
    libxfont2 \
    xauth \
    x11-xserver-utils \
    && echo "zh_CN.UTF-8 UTF-8" > /etc/locale.gen \
    && echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen

# 2. 安装官方 KasmVNC Debian 12 (Bookworm) 预编译包
RUN ARCH=$(dpkg --print-architecture) \
    && KASM_VER="1.3.2" \
    && wget -q https://github.com/kasmtech/KasmVNC/releases/download/v${KASM_VER}/kasmvncserver_bookworm_${KASM_VER}_${ARCH}.deb -O /tmp/kasmvnc.deb \
    && apt-get install -y /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/*

# 3. 创建运行目录
RUN mkdir -p /data /certs /etc/ssl/app /tmp/crashpad /etc/kasmvnc

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /data

# 暴露端口：8444(KasmVNC HTTPS Web), 9222(CDP 穿透端口)
EXPOSE 8444 9222

# 使用 tini 接管信号与僵尸进程回收
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# 默认参数（支持通过命令行追加自定义 URL 或参数覆盖）
CMD []