# ==============================================================================
# 阶段 1：编译 Vue 3 前端静态资产 (Multi-Platform Build Kit)
# ==============================================================================
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend-builder
WORKDIR /build

COPY app/frontend/package*.json ./
RUN npm install

COPY app/frontend/ ./
RUN npm run build

# ==============================================================================
# 阶段 2：提前编译/打包 Python Wheel 二进制轮子 (Builder 阶段)
# 彻底隔离编译依赖 (gcc, libffi, openssl-dev)，不在最终生产镜像中留下任何残留
# ==============================================================================
FROM python:3.11-alpine AS python-builder
WORKDIR /wheels

# 安装预编译所需工具
RUN apk add --no-cache gcc musl-dev libffi-dev openssl-dev cargo

# 关键：升级 pip 以识别 musllinux wheel
RUN pip install --no-cache-dir --upgrade pip

COPY app/backend/requirements.txt .
# 预先下载并编译所有依赖为独立 wheel 轮子文件
RUN pip wheel --no-cache-dir --wheel-dir=/wheels -r requirements.txt

# ==============================================================================
# 阶段 3：极致轻量化生产运行镜像 (Final Slim Image)
# ==============================================================================
FROM python:3.11-alpine AS runner
WORKDIR /app

LABEL maintainer="Wimotek <i@Wimotek.com>"
LABEL description="Xray-Web Master Control Hub (Optimized & Precompiled)"

# 仅安装生产必须的运行时动态链接库 (无 gcc/cargo/pip 缓存污染)
RUN apk add --no-cache ca-certificates tzdata openssl

# adduser 与 mkdir/chown 逻辑相关，合并成一层是合理的 (包含持久化 /data 与运行期证书目录 /app/certs)
RUN addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S -G appgroup -s /sbin/nologin appuser && \
    mkdir -p /data /app/certs && chown -R appuser:appgroup /data /app/certs

# 关键：bind mount，wheels 不进入任何层
RUN --mount=type=bind,from=python-builder,source=/wheels,target=/wheels \
    pip install --no-cache-dir --no-index --find-links=/wheels /wheels/*.whl

COPY --chown=appuser:appgroup --chmod=755 app/backend/ ./backend/
COPY --chown=appuser:appgroup --from=frontend-builder /build/dist ./frontend/dist

WORKDIR /app/backend
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WEB_PORT=8443

USER appuser

# EXPOSE 为镜像默认元数据声明（默认 8443，运行时可通过 -e WEB_PORT=自定义端口 自由指定）
EXPOSE 8443
VOLUME ["/data"]

# 容器健康检查：动态解析 ${WEB_PORT} 端口与 /healthz 端点
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --no-check-certificate -q --spider "https://127.0.0.1:${WEB_PORT:-8443}/healthz" || exit 1

# 关键：使用 entrypoint.sh 统一接管证书预热与动态 ${WEB_PORT} 端口启动
ENTRYPOINT ["/app/backend/entrypoint.sh"]
CMD ["granian-default"]