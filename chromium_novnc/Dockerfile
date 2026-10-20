FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 优化策略：
# 1. 安装 Chromium、Xvfb、Openbox、noVNC 与文泉驿中文字体
# 2. 安装 gosu 工具，用于容器安全降权与数据卷权限自愈
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

# 创建非特权用户 appuser (UID 1000) 与必要运行目录
RUN useradd -m -u 1000 -s /bin/bash appuser && \
    mkdir -p /data /home/appuser /tmp/.X11-unix /certs && \
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix /certs && \
    chmod 1777 /tmp/.X11-unix

WORKDIR /home/appuser

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 暴露端口：
# 6080: HTTP Web 界面 (noVNC)
# 6443: HTTPS Web 界面 (noVNC)
# 9222: CDP 自动化调试协议
EXPOSE 6080 6443 9222

# 入口由 tini 代理，启动时在 entrypoint 内部完成权限修复并降权至 appuser 运行
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD []
