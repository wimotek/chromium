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

	// 1. Go 原生接管 PID 1 僵尸进程回收（无需外挂 tini / dumb-init）
	go initZombieReaper()

	ctx, cancel := context.WithCancel(context.Background())

	// 2. 启动 Nginx 看门狗守护（意外崩溃 1 秒内自愈拉起）
	go watchdogNginx(ctx)

	// 3. 注册 API 路由
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
	mux.HandleFunc("/api/ssl/issue", api.AuthMiddleware(cfg.AuthToken, handler.IssueSSL))
	mux.Handle("/", web.Handler())

	srv := &http.Server{
		Addr:         cfg.HttpPort,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	// 4. 优雅下线信号监听
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigChan
		log.Printf("[INFO] 收到系统信号: %v，准备优雅下线...", sig)

		cancel() // 停止看门狗，防止停止时被重新拉起
		
		shutdownCtx, sCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer sCancel()
		srv.Shutdown(shutdownCtx)

		// 退出 Nginx
		exec.Command("nginx", "-s", "quit").Run()
		os.Exit(0)
	}()

	log.Printf("[INFO] 安全微内核已启动，监听在 %s (当前运行 UID: %d)", cfg.HttpPort, os.Getuid())
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[FATAL] 控制台异常退出: %v", err)
	}
}

// 非阻塞回收孤儿子进程
func initZombieReaper() {
	ch := make(chan os.Signal, 32)
	signal.Notify(ch, syscall.SIGCHLD)
	for range ch {
		for {
			var status syscall.WaitStatus
			pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
			if err != nil || pid <= 0 {
				break
			}
		}
	}
}

// Nginx 高可用看门狗
func watchdogNginx(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		cmd := exec.Command("nginx", "-g", "daemon off;")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		if err := cmd.Run(); err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				log.Printf("[WARN] Nginx 主进程异常退出: %v，看门狗将在 1 秒后自动拉起...", err)
				time.Sleep(1 * time.Second)
			}
		}
	}
}