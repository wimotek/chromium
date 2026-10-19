FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 安装图形环境、noVNC、文泉驿中文字体与 gosu 降权工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    openbox \
    novnc \
    websockify \
    fonts-wqy-zenhei \
    socat \
    openssl \
    tini \
    gosu \
    ca-certificates \
    && ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
    && rm -rf /var/lib/apt/lists/*

# 创建非 root 用户 appuser (UID 1000)
RUN useradd -m -u 1000 -s /bin/bash appuser && \
    mkdir -p /data /home/appuser /tmp/.X11-unix && \
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix

WORKDIR /home/appuser

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 暴露端口：6080(HTTP), 6443(HTTPS), 9222(CDP)
EXPOSE 6080 6443 9222

# 入口使用 tini，由 entrypoint 内部自动完成自愈赋权并降权为 appuser 运行
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD []
