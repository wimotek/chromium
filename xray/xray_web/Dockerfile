# ================= 阶段 1：编译 Vue 3 前端 =================
FROM --platform=$BUILDPLATFORM node:20-slim AS frontend-builder
WORKDIR /build

COPY app/frontend/package*.json ./
RUN npm install

COPY app/frontend/ ./
RUN npm run build

# ================= 阶段 2：轻量主控面板生产运行环境 =================
FROM python:3.10-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    openssl \
    && rm -rf /var/lib/apt/lists/*

COPY app/backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r ./backend/requirements.txt

COPY app/backend/ ./backend/
COPY --from=frontend-builder /build/dist ./frontend/dist

WORKDIR /app/backend
EXPOSE 3000
VOLUME ["/data"]

CMD ["python3", "app.py"]