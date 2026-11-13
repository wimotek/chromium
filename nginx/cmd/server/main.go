package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/wimotek/nginx/internal/api"
	"github.com/wimotek/nginx/internal/config"
	"github.com/wimotek/nginx/internal/nginx"
	"github.com/wimotek/nginx/internal/web"
)

func main() {
	cfg := config.Load()
	execCtrl := nginx.NewExecutor()
	mgr := nginx.NewManager(cfg.NginxDir, execCtrl)
	handler := api.NewHandler(cfg, mgr, execCtrl)

	// 1. 启动后台 Nginx (PID 1 委托模式)
	nginxCmd := exec.Command("nginx", "-g", "daemon off;")
	nginxCmd.Stdout = os.Stdout
	nginxCmd.Stderr = os.Stderr
	if err := nginxCmd.Start(); err != nil {
		log.Fatalf("[FATAL] 启动 Nginx 失败: %v", err)
	}
	log.Println("[INFO] Nginx 核心网关已启动")

	// 2. 注册 REST API 路由
	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", handler.Login)
	mux.HandleFunc("/api/sites", api.AuthMiddleware(cfg.AuthToken, handler.ListSites))
	mux.HandleFunc("/api/site", api.AuthMiddleware(cfg.AuthToken, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handler.GetSite(w, r)
		case http.MethodPost:
			handler.SaveSite(w, r)
		case http.MethodDelete:
			handler.DeleteSite(w, r)
		default:
			http.Error(w, "Method Not Allowed", 405)
		}
	}))
	mux.HandleFunc("/api/reload", api.AuthMiddleware(cfg.AuthToken, handler.Reload))
	mux.Handle("/", web.Handler())

	srv := &http.Server{
		Addr:         cfg.HttpPort,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	// 3. 优雅停机信号处理
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigChan
		log.Printf("[INFO] 收到系统信号: %v，平滑退出中...", sig)

		// 退出 Web 服务与 Nginx
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)

		exec.Command("nginx", "-s", "quit").Run()
		nginxCmd.Wait()
		os.Exit(0)
	}()

	log.Printf("[INFO] Wimotek Nginx 控制面板监听在 %s", cfg.HttpPort)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[FATAL] 异常崩溃: %v", err)
	}
}