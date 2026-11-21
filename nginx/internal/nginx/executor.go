package nginx

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type ModuleInfo struct {
	Name        string `json:"name"`
	Category    string `json:"category"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
}

type BuildInfo struct {
	Version       string       `json:"version"`
	Compiler      string       `json:"compiler"`
	ConfigureArgs []string     `json:"configure_args"`
	Modules       []ModuleInfo `json:"modules"`
	CustomModules []string     `json:"custom_modules"`
	Running       bool         `json:"running"`
	PID           int          `json:"pid"`
	UptimeSeconds int64        `json:"uptime_seconds"`
	RawOutput     string       `json:"raw_output"`
}

type Executor struct {
	bin       string
	pidFile   string
	startTime time.Time
}

func NewExecutor(bin string) *Executor {
	if bin == "" {
		bin = "nginx"
	}
	return &Executor{
		bin:       bin,
		pidFile:   "/run/nginx/nginx.pid",
		startTime: time.Now(),
	}
}

// TestConfig 严禁 /bin/sh -c 拼接字符串，直接执行 nginx -t
func (e *Executor) TestConfig() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, e.bin, "-t")
	out, err := cmd.CombinedOutput()
	outStr := strings.TrimSpace(string(out))
	if err != nil {
		return outStr, fmt.Errorf("语法校验失败: %s", outStr)
	}
	return outStr, nil
}

// Reload 先校验配置语法，通过后平滑热重载
func (e *Executor) Reload() (string, error) {
	testOut, err := e.TestConfig()
	if err != nil {
		return testOut, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, e.bin, "-s", "reload")
	out, err := cmd.CombinedOutput()
	outStr := strings.TrimSpace(string(out))
	if err != nil {
		return outStr, fmt.Errorf("热重载失败: %s", outStr)
	}
	if outStr == "" {
		return testOut, nil
	}
	return outStr, nil
}

// CheckStatus 检查 Nginx Master 进程运行状态与 PID
func (e *Executor) CheckStatus() (bool, int) {
	data, err := os.ReadFile(e.pidFile)
	if err != nil {
		return false, 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return false, 0
	}
	if err := syscall.Kill(pid, 0); err != nil {
		return false, 0
	}
	return true, pid
}

var (
	nginxVerRegex  = regexp.MustCompile(`nginx version:\s*nginx/([^\s]+)`)
	compilerRegex  = regexp.MustCompile(`built by\s+(.+)`)
	configArgRegex = regexp.MustCompile(`configure arguments:\s*(.+)`)
)

// BuildInfo 解析 nginx -V 输出，识别内置模块、gzip_static、HTTP/3、Brotli 及自定义编译参数
func (e *Executor) GetBuildInfo() BuildInfo {
	running, pid := e.CheckStatus()
	info := BuildInfo{
		Running:       running,
		PID:           pid,
		UptimeSeconds: int64(time.Since(e.startTime).Seconds()),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, e.bin, "-V")
	out, _ := cmd.CombinedOutput()
	raw := strings.TrimSpace(string(out))
	info.RawOutput = raw

	if m := nginxVerRegex.FindStringSubmatch(raw); len(m) == 2 {
		info.Version = m[1]
	} else {
		info.Version = "unknown"
	}

	if m := compilerRegex.FindStringSubmatch(raw); len(m) == 2 {
		info.Compiler = strings.TrimSpace(m[1])
	}

	var argLine string
	if m := configArgRegex.FindStringSubmatch(raw); len(m) == 2 {
		argLine = strings.TrimSpace(m[1])
		info.ConfigureArgs = splitConfigureArgs(argLine)
	}

	hasArg := func(needle string) bool {
		return strings.Contains(argLine, needle)
	}

	info.Modules = []ModuleInfo{
		{Name: "http_ssl_module", Category: "默认 · 协议安全", Description: "HTTPS / TLS 1.2 & TLS 1.3 加密传输支持", Enabled: hasArg("--with-http_ssl_module")},
		{Name: "http_v2_module", Category: "默认 · 协议安全", Description: "HTTP/2 多路复用与头部压缩", Enabled: hasArg("--with-http_v2_module")},
		{Name: "http_v3_module", Category: "默认 · 协议安全", Description: "HTTP/3 QUIC 低延迟传输协议支持", Enabled: hasArg("--with-http_v3_module")},
		{Name: "http_realip_module", Category: "默认 · 路由运维", Description: "穿透 CDN / 反代精准还原客户端真实 IP", Enabled: hasArg("--with-http_realip_module")},
		{Name: "http_gunzip_module", Category: "默认 · 压缩兼容", Description: "为不支持 gzip 的客户端按需解压压缩响应", Enabled: hasArg("--with-http_gunzip_module")},
		{Name: "http_dav & mp4/flv", Category: "默认 · 行业对齐", Description: "WebDAV、MP4/FLV 流媒体与安全链接等官方标准模块", Enabled: hasArg("--with-http_dav_module") || hasArg("--with-http_mp4_module")},
		{Name: "http_stub_status_module", Category: "默认 · 监控运维", Description: "暴露实时连接数与请求指标供 Prometheus/探针采集", Enabled: hasArg("--with-http_stub_status_module")},
		{Name: "stream_ssl_preread_module", Category: "默认 · 四层转发", Description: "TCP/UDP 四层流量代理与 SNI 无解密分流", Enabled: hasArg("--with-stream_ssl_preread_module")},
		{Name: "pcre_jit & threads", Category: "默认 · 底层性能", Description: "PCRE JIT 正则加速与异步线程池文件 I/O", Enabled: hasArg("--with-pcre-jit") || hasArg("--with-threads")},
		{Name: "http_gzip_static_module", Category: "自定义开关", Description: "通过 ENABLE_GZIP_STATIC=true 编译，直出 .gz 预压缩文件", Enabled: hasArg("--with-http_gzip_static_module")},
		{Name: "ngx_brotli", Category: "自定义开关", Description: "通过 ENABLE_BROTLI=true 编译，支持 .br 静态/动态压缩", Enabled: hasArg("brotli")},
		{Name: "headers-more-nginx-module", Category: "自定义开关", Description: "通过 ENABLE_HEADERS_MORE=true 编译，灵活改写响应头", Enabled: hasArg("headers-more")},
	}

	for _, a := range info.ConfigureArgs {
		if strings.HasPrefix(a, "--add-module=") || strings.HasPrefix(a, "--add-dynamic-module=") {
			info.CustomModules = append(info.CustomModules, a)
		}
	}

	return info
}

func splitConfigureArgs(line string) []string {
	var args []string
	var cur strings.Builder
	inQuote := byte(0)

	for i := 0; i < len(line); i++ {
		ch := line[i]
		if inQuote != 0 {
			if ch == inQuote {
				inQuote = 0
			} else {
				cur.WriteByte(ch)
			}
			continue
		}
		if ch == '\'' || ch == '"' {
			inQuote = ch
			continue
		}
		if ch == ' ' || ch == '\t' {
			if cur.Len() > 0 {
				args = append(args, cur.String())
				cur.Reset()
			}
			continue
		}
		cur.WriteByte(ch)
	}
	if cur.Len() > 0 {
		args = append(args, cur.String())
	}
	return args
}