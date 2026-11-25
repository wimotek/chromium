# syntax=docker/dockerfile:1.7
# Multi-stage static Go build for wimotek-cli (CGO_ENABLED=0, non-root UID 10001)

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS builder
WORKDIR /src
ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -X main.Version=${VERSION}" \
    -o /out/wimotek-cli ./cmd/wimotek-cli

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 10001 -H -s /sbin/nologin wimotek \
 && mkdir -p /data \
 && chown -R 10001:10001 /data

COPY --from=builder /out/wimotek-cli /usr/local/bin/wimotek-cli

ENV WIMOTEK_PATH=/data \
    WIMOTEK_CLI_LISTEN=0.0.0.0:9443

USER 10001:10001
VOLUME ["/data"]
EXPOSE 9443

ENTRYPOINT ["/usr/local/bin/wimotek-cli"]
CMD ["web"]
