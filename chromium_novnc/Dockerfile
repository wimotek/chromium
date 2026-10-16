FROM alpine:3.20

# 优化策略：
# 1. 禁用文档与缓存
# 2. 仅安装必要组件与文泉驿正黑（支持中文）
# 3. 包含 openssl (自签证书)、socat (CDP端口转发)、tini (PID 1 回收子进程)
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
    tini \
    && ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
    && rm -rf /tmp/* /var/cache/apk/*

WORKDIR /root

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 创建数据卷挂载点
RUN mkdir -p /data

# 暴露端口：
# 6080: HTTP Web 访问
# 6443: HTTPS Web 访问
# 9222: CDP 远程调试协议
EXPOSE 6080 6443 9222

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD []
