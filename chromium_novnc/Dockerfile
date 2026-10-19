FROM alpine:3.20

# 优化策略：
# 1. 安装图形环境、noVNC、文泉驿中文字体
# 2. 安装 su-exec (Alpine 官方推荐的高性能降权工具)
RUN apk add --no-cache \
    chromium \
    xvfb \
    x11vnc \
    openbox \
    novnc \
    websockify \
    font-wqy-zenhei \
    socat \
    openssl \
    su-exec \
    tini \
    && ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
    && rm -rf /tmp/* /var/cache/apk/*

# 创建非 root 用户 appuser (UID 1000)
RUN adduser -D -u 1000 appuser && \
    mkdir -p /data /home/appuser /tmp/.X11-unix && \
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix

WORKDIR /home/appuser

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 暴露端口：6080(HTTP), 6443(HTTPS), 9222(CDP)
EXPOSE 6080 6443 9222

# 入口使用 tini，由 entrypoint 内部自动完成自愈赋权并降权为 appuser 运行
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD []
