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

# 先创建固定 UID/GID 的非 root 用户（安全核心）
RUN addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S -G appgroup -s /sbin/nologin appuser

COPY --from=python-builder /wheels /tmp/wheels
RUN pip install --no-cache-dir --no-index --find-links=/tmp/wheels /tmp/wheels/*.whl gunicorn && \
    rm -rf /tmp/wheels

COPY --chown=appuser:appgroup app/backend/ ./backend/
COPY --chown=appuser:appgroup --from=frontend-builder /build/dist ./frontend/dist

WORKDIR /app/backend
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER appuser

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/')" || exit 1

# 稳定核心：Gunicorn 多 worker，2×CPU+1 起步
CMD ["gunicorn", "--bind", "0.0.0.0:3000", \
     "--workers", "5", \
     "--threads", "2", \
     "--timeout", "60", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "app:app"]