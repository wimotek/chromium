# ==============================================================================
# 阶段 1：编译 Vue 3 前端静态资产 (Node 22 LTS + 原生 glibc 构建平台，满足 @vueuse/core@15+ 的 Node>=22 要求并避免 Alpine musl 原生包缺失)
# ==============================================================================
FROM --platform=$BUILDPLATFORM node:22-slim AS frontend-builder
WORKDIR /build

ENV NODE_OPTIONS="--max-old-space-size=2048"

COPY app/frontend/package.json ./
RUN npm install --no-audit --no-fund

COPY app/frontend/ ./
RUN npm run build

# ==============================================================================
# 阶段 2：构建依赖 Wheel 缓存 (python:3.11-slim manylinux 预编译轮子，免去 Rust/Cargo 编译)
# ==============================================================================
FROM python:3.11-slim AS python-builder
WORKDIR /wheels

COPY app/backend/requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip wheel --no-cache-dir --wheel-dir=/wheels -r requirements.txt

# ==============================================================================
# 阶段 3：Cython 编译 Hub 后端全部业务源码为原生 ELF .so 二进制并剥离源码与符号
# ==============================================================================
FROM python:3.11-slim AS backend-builder
WORKDIR /build/backend

RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc python3-dev binutils && \
    rm -rf /var/lib/apt/lists/* && \
    pip install --no-cache-dir "cython>=3.0,<3.2" setuptools

RUN --mount=type=bind,from=python-builder,source=/wheels,target=/wheels \
    pip install --no-cache-dir --no-index --find-links=/wheels /wheels/*.whl

COPY app/backend/ ./
RUN python3 build_binary.py && \
    chmod 755 /build/backend/entrypoint.sh && \
    python3 -c "import os, shutil, tempfile; d=tempfile.mkdtemp(); os.environ['DATA_DIR']=d; os.environ['BACKUP_DIR']=os.path.join(d,'backups'); os.environ['DB_PATH']=os.path.join(d,'t.db'); os.environ['HUB_CONFIG_PATH']=os.path.join(d,'hub.json'); import app, config, core.cache, core.rate_limit, core.captcha, core.db, core.cert_init, routes; assert hasattr(app, 'app'); shutil.rmtree(d, ignore_errors=True); shutil.rmtree('/data', ignore_errors=True)"

# ==============================================================================
# 阶段 4：极致精简非 Root 闭源运行镜像 (零 .py 业务源码，零编译工具链残留)
# ==============================================================================
FROM python:3.11-slim AS runner
WORKDIR /app

LABEL maintainer="Wimotek <i@Wimotek.com>"
LABEL description="Xray-Web Master Control Hub (Compiled Cython Binaries & Multi-Arch)"

# 安装最小化运行时工具：ca-certificates、tzdata、openssl、dumb-init、gosu(安全降权)、libcap2-bin(非root绑定443)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates tzdata openssl dumb-init gosu libcap2-bin && \
    ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo Asia/Shanghai > /etc/timezone && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -g 10001 -r appgroup && \
    useradd -u 10001 -r -g appgroup -s /usr/sbin/nologin appuser && \
    mkdir -p /data /data/backups /app/certs && \
    chown -R appuser:appgroup /data /app/certs && \
    setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which python3)")"

# 关键：bind mount，wheels 不进入任何镜像层
RUN --mount=type=bind,from=python-builder,source=/wheels,target=/wheels \
    pip install --no-cache-dir --no-index --find-links=/wheels /wheels/*.whl

# 仅拷贝已编译且 strip 的 .so 原生模块与前端构建产物，不含任何业务源码与 gcc/cython
COPY --chown=appuser:appgroup --chmod=755 --from=backend-builder /build/backend/ ./backend/
COPY --chown=appuser:appgroup --from=frontend-builder /build/dist ./frontend/dist

WORKDIR /app/backend
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WEB_PORT=8443

EXPOSE 8443
VOLUME ["/data"]

# 容器健康检查：使用 Python 标准库动态探测 ${WEB_PORT}/healthz（兼容 SEPARATE_FRONTEND=true 与原生 HTTPS）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python3 -c "import os,ssl,urllib.request; sep=os.getenv('SEPARATE_FRONTEND','').lower() in ('true','1','yes'); port=os.getenv('WEB_PORT','8443'); url=f'{\"http\" if sep else \"https\"}://127.0.0.1:{port}/healthz'; ctx=None if sep else ssl._create_unverified_context(); urllib.request.urlopen(url, timeout=4, context=ctx).read()"

# 关键：dumb-init (PID 1 信号转发) -> entrypoint.sh (Root-Init-Drop 证书与权限初始化) -> gosu appuser
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/backend/entrypoint.sh"]
CMD ["granian-default"]