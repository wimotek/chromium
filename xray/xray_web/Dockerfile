# ==============================================================================
# 阶段 1：编译 Vue 3 前端静态资产 (Multi-Platform Build Kit)
# ==============================================================================
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend-builder
WORKDIR /build

COPY app/frontend/package*.json ./
# 采用 npm ci 保证 lockfile 精确一致，提升并行构建速度
RUN npm ci --prefer-offline --no-audit

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

# 从阶段 2 复制预编译好的 Wheel 轮子，直接秒级离线解压安装
COPY --from=python-builder /wheels /tmp/wheels
RUN pip install --no-cache-dir --no-index --find-links=/tmp/wheels /tmp/wheels/*.whl && \
    rm -rf /tmp/wheels

# 挂载后端业务代码与已编译前端静态资产
COPY app/backend/ ./backend/
COPY --from=frontend-builder /build/dist ./frontend/dist

WORKDIR /app/backend
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1

EXPOSE 3000
VOLUME ["/data"]

CMD ["python3", "app.py"]