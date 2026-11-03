FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# 【解决 echo $LANG 为空】：在此全局声明环境变量
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# 淘汰 x11vnc 和 xvfb，安装支持 UTF-8 剪贴板的 tigervnc-standalone-server
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    tigervnc-standalone-server \
    tigervnc-common \
    openbox \
    novnc \
    websockify \
    fonts-wqy-zenhei \
    socat \
    openssl \
    tini \
    gosu \
    ca-certificates \
    numlockx \
    && ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 -s /bin/bash appuser && \
    mkdir -p /data /home/appuser/.vnc /tmp/.X11-unix /certs && \
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix /certs && \
    chmod 1777 /tmp/.X11-unix

WORKDIR /home/appuser

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 6080 6443 9222

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD []