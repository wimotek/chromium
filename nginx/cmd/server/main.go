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
	config.BootstrapDataDir(cfg)

	execCtrl := nginx.NewExecutor(cfg.NginxBin)
	mgr := nginx.NewManager(cfg.NginxDir, cfg.NginxMainConf, execCtrl)
	acmeMgr := nginx.NewAcmeManager(cfg.SSLDir, cfg.AcmeWebRoot, cfg.AcmeScriptHome, cfg.AcmeHome, cfg.NginxBin)
	handler := api.NewHandler(cfg, mgr, execCtrl, acmeMgr)

	// 1. Go 原生接管 PID 1 僵尸进程回收（无需外挂 tini / dumb-init）
	go initZombieReaper()

	ctx, cancel := context.WithCancel(context.Background())

	// 2. 启动 Nginx 看门狗守护（意外崩溃 1 秒内自愈拉起）
	go watchdogNginx(ctx, cfg.NginxBin)

	// 3. 启动内置 ACME 证书自动续签调度器（每 12 小时检查一次，无需 crond）
	go acmeMgr.StartAutoRenew(ctx, cfg.AutoRenewInterval)

	// 4. 注册 API 与前端静态路由
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", handler.Health)
	mux.HandleFunc("/api/login", handler.Login)
	mux.HandleFunc("/api/system/info", api.AuthMiddleware(cfg.AuthToken, handler.SystemInfo))
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
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.HandleFunc("/api/site/test", api.AuthMiddleware(cfg.AuthToken, handler.TestSite))
	mux.HandleFunc("/api/site/toggle", api.AuthMiddleware(cfg.AuthToken, handler.ToggleSite))
	mux.HandleFunc("/api/nginx-conf", api.AuthMiddleware(cfg.AuthToken, handler.MainConfig))
	mux.HandleFunc("/api/reload", api.AuthMiddleware(cfg.AuthToken, handler.Reload))
	mux.HandleFunc("/api/certs", api.AuthMiddleware(cfg.AuthToken, handler.ListCerts))
	mux.HandleFunc("/api/ssl/issue", api.AuthMiddleware(cfg.AuthToken, handler.IssueSSL))
	mux.Handle("/", web.Handler())

	// WriteTimeout 设为 0 以避免阻塞长达 120~300s 的 ACME DNS-01 证书签发请求；
	// 常规短操作由各组件内部 context.WithTimeout 精确控制
	srv := &http.Server{
		Addr:              cfg.HttpPort,
		Handler:           api.SecurityHeadersMiddleware(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}

	// 5. 优雅下线信号监听
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigChan
		log.Printf("[INFO] 收到系统信号: %v，准备优雅下线...", sig)

		cancel()

		shutdownCtx, sCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer sCancel()
		_ = srv.Shutdown(shutdownCtx)

		_ = exec.Command(cfg.NginxBin, "-s", "quit").Run()
		os.Exit(0)
	}()

	log.Printf("[INFO] Wimotek Nginx 微内核已启动，监听 %s (UID: %d)", cfg.HttpPort, os.Getuid())
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[FATAL] 控制台异常退出: %v", err)
	}
}

// initZombieReaper 非阻塞回收孤儿子进程
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

// watchdogNginx Nginx 高可用看门狗
func watchdogNginx(ctx context.Context, nginxBin string) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		cmd := exec.Command(nginxBin, "-g", "daemon off;")
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