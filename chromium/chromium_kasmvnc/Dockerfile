# ---- 构建阶段：装编译工具 + venv ----
FROM debian:bookworm-slim AS pydeps
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir websockets httpx wimotek-edge-agent

# ---- 最终阶段 ----
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
    CHROME_ARGS= \
    REVERSE_TUNNEL=

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
    python3 \
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

RUN ARCH=$(dpkg --print-architecture) \
    && KASMVNC_VER="1.3.3" \
    && wget -q https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VER}/kasmvncserver_bookworm_${KASMVNC_VER}_${ARCH}.deb -O /tmp/kasmvnc.deb \
    && apt-get update \
    && apt-get install -y /tmp/kasmvnc.deb --no-install-recommends \
    && rm -f /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 -s /bin/bash kasm-user \
    && adduser kasm-user ssl-cert

RUN mkdir -p /data /certs /etc/ssl/app /tmp/crashpad /home/kasm-user/.vnc /etc/kasmvnc \
    && chown -R kasm-user:kasm-user /data /certs /etc/ssl/app /tmp/crashpad /home/kasm-user /etc/kasmvnc /opt/venv

COPY --chmod=755 entrypoint.sh /entrypoint.sh
COPY --chmod=755 edge_node_client.py /opt/edge_node_client.py

WORKDIR /data

# 暴露端口：6901(KasmVNC Web), 9222(CDP原生端口), 9223(socat备用穿透端口)
EXPOSE 6901 9222 9223

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD []