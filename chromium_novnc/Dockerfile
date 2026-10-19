FROM alpine:3.20

# 优化策略：
# 1. 安装图形环境、noVNC、文泉驿中文字体与必要排错工具
# 2. 引入 sudo 用于容器启动时自动修正挂载卷的权限
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
    sudo \
    tini \
    && ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
    && rm -rf /tmp/* /var/cache/apk/*

# 创建非 root 用户 appuser (UID 1000)，并赋予免密 sudo 权限用于卷权限自愈
RUN adduser -D -u 1000 appuser && \
    mkdir -p /data /home/appuser /tmp/.X11-unix && \
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix && \
    echo "appuser ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/appuser && \
    chmod 0440 /etc/sudoers.d/appuser

WORKDIR /home/appuser

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 暴露端口：6080(HTTP), 6443(HTTPS), 9222(CDP)
EXPOSE 6080 6443 9222

USER appuser

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD []
