APP_NAME := wimotek-ca
BUILD_DIR := bin

.PHONY: frontend build test cross-compile docker clean

frontend:
	cd frontend && npm install --no-audit --no-fund && npm run build

build: frontend
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BUILD_DIR)/$(APP_NAME) ./cmd/server

test:
	CGO_ENABLED=0 go test -v ./...

cross-compile: frontend
	mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(BUILD_DIR)/$(APP_NAME)-linux-amd64 ./cmd/server
	CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o $(BUILD_DIR)/$(APP_NAME)-linux-arm64 ./cmd/server
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(BUILD_DIR)/$(APP_NAME)-windows-amd64.exe ./cmd/server
	CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o $(BUILD_DIR)/$(APP_NAME)-darwin-arm64 ./cmd/server

docker:
	docker build -t wimotek/ca:local -f Dockerfile .

clean:
	rm -rf $(BUILD_DIR) web/dist
