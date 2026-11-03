FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    DISPLAY=:0 \
    RESOLUTION=1920x1080 \
    VNC_PASSWORD= \
    CHROME_ARGS=

# 1. 安装基础依赖、Chromium、Openbox、socat、gosu、tini、numlockx 及中文字体
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    gosu \
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
    libxcomposite1 \
    libxfixes3 \
    libxrandr2 \
    libxcursor1 \
    libxi6 \
    libxtst6 \
    libxinerama1 \
    ssl-cert \
    && echo "zh_CN.UTF-8 UTF-8" > /etc/locale.gen \
    && echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# 2. 自动检测 CPU 架构并安装官方最新稳定版 KasmVNC Server
RUN ARCH=$(dpkg --print-architecture) \
    && KASMVNC_VER="1.3.3" \
    && wget -q https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VER}/kasmvncserver_bookworm_${KASMVNC_VER}_${ARCH}.deb -O /tmp/kasmvnc.deb \
    && apt-get update \
    && apt-get install -y /tmp/kasmvnc.deb --no-install-recommends \
    && rm -f /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/*

# 3. 创建 Kasm 专属普通用户 kasm-user (UID 1000)，加入 ssl-cert 组
RUN useradd -m -u 1000 -s /bin/bash kasm-user \
    && adduser kasm-user ssl-cert

# 4. 创建工作、运行与证书挂载目录
RUN mkdir -p /data /certs /etc/ssl/app /tmp/crashpad /home/kasm-user/.vnc /etc/kasmvnc \
    && chown -R kasm-user:kasm-user /data /certs /etc/ssl/app /tmp/crashpad /home/kasm-user /etc/kasmvnc

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /data

# 暴露端口：6901(KasmVNC Web 端), 9222(CDP 穿透端口)
EXPOSE 6901 9222

# 使用 tini 接管信号处理
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

CMD []