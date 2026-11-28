package handlers

import (
	"fmt"
	"html"
	"net/url"
	"regexp"
	"strings"

	"github.com/wimotek/url/internal/config"
)

var hexColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func sanitizeHexColor(raw string) string {
	v := strings.TrimSpace(raw)
	if hexColorPattern.MatchString(v) {
		return v
	}
	return "#2563EB"
}

func getPresetTemplateHTML(preset string) string {
	switch preset {
	case "minimal_fast":
		return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>{{TITLE}} · {{BRAND_NAME}}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#f8fafc;color:#0f172a}
    .box{width:100%;max-width:420px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;text-align:center}
    .spinner{width:28px;height:28px;margin:0 auto 16px;border:3px solid #e2e8f0;border-top-color:{{PRIMARY_COLOR}};border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    h1{margin:0 0 8px;font-size:18px;font-weight:600}
    p{margin:0 0 18px;font-size:13px;color:#64748b;line-height:1.6}
    .host{display:inline-block;padding:6px 12px;border-radius:8px;background:#f1f5f9;font-family:monospace;font-size:12px;color:#334155;margin-bottom:20px;word-break:break-all}
    .btn{display:inline-block;width:100%;padding:10px 16px;border-radius:8px;background:{{PRIMARY_COLOR}};color:#fff;text-decoration:none;font-size:13px;font-weight:600}
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner" aria-hidden="true"></div>
    <h1>{{HEADLINE}}</h1>
    <p>{{SUBTITLE}}</p>
    {{TARGET_URL_BLOCK}}
    <a class="btn" href="{{TARGET_URL}}" rel="noopener noreferrer">{{CTA_TEXT}} <span id="cd"></span></a>
  </div>
  {{COUNTDOWN_SCRIPT}}
</body>
</html>`
	case "branded_countdown":
		return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>{{TITLE}} · {{BRAND_NAME}}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:linear-gradient(180deg,#f8fafc 0%,#eff6ff 100%);color:#0f172a}
    .card{width:100%;max-width:480px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:32px;box-shadow:0 16px 40px rgba(15,23,42,.06)}
    .brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;font-size:13px;font-weight:700;color:#0f172a}
    .badge{font-size:11px;font-weight:600;color:#047857;background:#ecfdf5;border:1px solid #a7f3d0;padding:3px 8px;border-radius:6px}
    h1{margin:0 0 8px;font-size:20px;font-weight:700;line-height:1.35}
    .sub{margin:0 0 18px;font-size:13px;color:#475569;line-height:1.6}
    .dest{padding:12px 14px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;font-family:monospace;font-size:12px;color:#1e293b;word-break:break-all;margin-bottom:18px}
    .bar-wrap{height:6px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-bottom:20px}
    .bar{height:100%;background:{{PRIMARY_COLOR}};width:100%;transition:width 1s linear}
    .btn{display:block;width:100%;text-align:center;padding:11px 16px;border-radius:8px;background:{{PRIMARY_COLOR}};color:#fff;text-decoration:none;font-size:14px;font-weight:600}
    .tip{margin-top:16px;font-size:12px;color:#64748b;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand"><span>{{BRAND_NAME}}</span>{{SECURITY_BADGE}}</div>
    <h1>{{HEADLINE}}</h1>
    <p class="sub">{{SUBTITLE}}</p>
    {{TARGET_URL_BLOCK}}
    <div class="bar-wrap"><div class="bar" id="bar"></div></div>
    <a class="btn" href="{{TARGET_URL}}" rel="noopener noreferrer">{{CTA_TEXT}} <span id="cd"></span></a>
    {{SAFETY_TIP_BLOCK}}
  </div>
  {{COUNTDOWN_SCRIPT}}
</body>
</html>`
	case "promo_wechat":
		return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>{{TITLE}} · {{BRAND_NAME}}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#f8fafc;color:#0f172a}
    .wx-bar{width:100%;max-width:460px;margin-bottom:14px;padding:10px 14px;border-radius:10px;background:#0f172a;color:#f8fafc;font-size:12px;display:flex;align-items:center;justify-content:space-between}
    .card{width:100%;max-width:460px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;box-shadow:0 12px 32px rgba(15,23,42,.06)}
    .brand{font-size:12px;font-weight:700;color:{{PRIMARY_COLOR}};margin-bottom:10px;text-transform:uppercase;letter-spacing:.04em}
    h1{margin:0 0 8px;font-size:19px;font-weight:700}
    p{margin:0 0 16px;font-size:13px;color:#475569;line-height:1.6}
    .dest{padding:11px 12px;border-radius:8px;background:#f1f5f9;font-family:monospace;font-size:12px;color:#1e293b;word-break:break-all;margin-bottom:16px}
    .notice{padding:10px 12px;border-radius:8px;background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;font-size:12px;margin-bottom:18px;line-height:1.5}
    .btn{display:block;width:100%;text-align:center;padding:11px 16px;border-radius:8px;background:{{PRIMARY_COLOR}};color:#fff;text-decoration:none;font-size:14px;font-weight:600}
  </style>
</head>
<body>
  {{WECHAT_TIP_BLOCK}}
  <div class="card">
    <div class="brand">{{BRAND_NAME}} · 307 安全直达</div>
    <h1>{{HEADLINE}}</h1>
    <p>{{SUBTITLE}}</p>
    {{TARGET_URL_BLOCK}}
    {{SAFETY_TIP_BLOCK}}
    <a class="btn" href="{{TARGET_URL}}" rel="noopener noreferrer">{{CTA_TEXT}} <span id="cd"></span></a>
  </div>
  {{COUNTDOWN_SCRIPT}}
</body>
</html>`
	default:
		return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>{{TITLE}} · {{BRAND_NAME}}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#f8fafc;color:#0f172a}
    .card{width:100%;max-width:480px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px 30px;box-shadow:0 10px 30px rgba(15,23,42,.05)}
    .top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:16px;border-bottom:1px solid #e2e8f0;margin-bottom:20px}
    .brand{font-size:14px;font-weight:700;color:#0f172a}
    .badge{font-size:11px;font-weight:600;color:#047857;background:#ecfdf5;border:1px solid #a7f3d0;padding:3px 8px;border-radius:6px}
    h1{margin:0 0 8px;font-size:18px;font-weight:700;line-height:1.4}
    .sub{margin:0 0 18px;font-size:13px;color:#475569;line-height:1.6}
    .dest{padding:12px 14px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;font-family:monospace;font-size:12px;color:#0f172a;word-break:break-all;margin-bottom:16px}
    .dest-host{font-weight:700;color:{{PRIMARY_COLOR}};margin-bottom:4px;font-size:13px}
    .tip{padding:10px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12px;line-height:1.5;margin-bottom:18px}
    .actions{display:flex;gap:10px}
    .btn{flex:1;text-align:center;padding:10px 16px;border-radius:8px;background:{{PRIMARY_COLOR}};color:#fff;text-decoration:none;font-size:13px;font-weight:600}
    .back{padding:10px 14px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:13px;cursor:pointer}
  </style>
</head>
<body>
  <div class="card">
    <div class="top">
      <span class="brand">{{BRAND_NAME}}</span>
      {{SECURITY_BADGE}}
    </div>
    <h1>{{HEADLINE}}</h1>
    <p class="sub">{{SUBTITLE}}</p>
    {{TARGET_URL_BLOCK}}
    {{SAFETY_TIP_BLOCK}}
    <div class="actions">
      <button class="back" type="button" onclick="history.back()">返回上一页</button>
      <a class="btn" href="{{TARGET_URL}}" rel="noopener noreferrer">{{CTA_TEXT}} <span id="cd"></span></a>
    </div>
  </div>
  {{COUNTDOWN_SCRIPT}}
</body>
</html>`
	}
}

func renderInterstitialHTML(cfg config.InterstitialConfig, title, targetURL, shortURL string) string {
	safeURL := "#"
	targetHost := "unknown"
	isHTTPS := false
	if parsed, err := url.Parse(strings.TrimSpace(targetURL)); err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" {
		safeURL = parsed.String()
		targetHost = parsed.Host
		isHTTPS = parsed.Scheme == "https"
	}

	seconds := cfg.CountdownSeconds
	if seconds < 0 {
		seconds = 0
	}
	if seconds > 15 {
		seconds = 15
	}

	primaryColor := sanitizeHexColor(cfg.PrimaryColor)
	if strings.TrimSpace(title) == "" {
		title = targetHost
	}

	securityBadge := ""
	if cfg.ShowSecurityBadge {
		if isHTTPS {
			securityBadge = `<span class="badge">HTTPS 安全校验通过</span>`
		} else {
			securityBadge = `<span class="badge" style="color:#b45309;background:#fffbeb;border-color:#fde68a">HTTP 非加密链接</span>`
		}
	}

	targetBlock := ""
	if cfg.ShowTargetUrl {
		if cfg.Preset == "minimal_fast" {
			targetBlock = fmt.Sprintf(`<div class="host">%s</div>`, html.EscapeString(targetHost))
		} else {
			targetBlock = fmt.Sprintf(`<div class="dest"><div class="dest-host">%s</div><div>%s</div></div>`,
				html.EscapeString(targetHost), html.EscapeString(safeURL))
		}
	}

	safetyBlock := ""
	if strings.TrimSpace(cfg.SafetyTip) != "" {
		cls := "tip"
		if cfg.Preset == "promo_wechat" {
			cls = "notice"
		}
		safetyBlock = fmt.Sprintf(`<div class="%s">%s</div>`, cls, html.EscapeString(cfg.SafetyTip))
	}

	wechatBlock := ""
	if cfg.ShowWechatTip {
		wechatBlock = `<div class="wx-bar"><span>如在微信 / App 内无法打开，请点击右上角选择“在默认浏览器中打开”</span><span>↗</span></div>`
	}

	countdownScript := ""
	if seconds > 0 && safeURL != "#" {
		countdownScript = fmt.Sprintf(`<script>(function(){var s=%d,total=%d,u=%q,cd=document.getElementById('cd'),bar=document.getElementById('bar');function tick(){if(cd)cd.textContent='('+s+'s)';if(bar&&total>0)bar.style.width=Math.max(0,(s/total)*100)+'%%';if(s<=0){window.location.replace(u);return;}s--;setTimeout(tick,1000);}tick();})();</script>`,
			seconds, seconds, safeURL)
	}

	tmpl := getPresetTemplateHTML(cfg.Preset)
	if cfg.UseCustomHtml && strings.TrimSpace(cfg.CustomHtml) != "" {
		tmpl = cfg.CustomHtml
	}

	replacer := strings.NewReplacer(
		"{{BRAND_NAME}}", html.EscapeString(cfg.BrandName),
		"{{TITLE}}", html.EscapeString(title),
		"{{HEADLINE}}", html.EscapeString(cfg.Headline),
		"{{SUBTITLE}}", html.EscapeString(cfg.Subtitle),
		"{{CTA_TEXT}}", html.EscapeString(cfg.CtaText),
		"{{SAFETY_TIP}}", html.EscapeString(cfg.SafetyTip),
		"{{TARGET_URL}}", html.EscapeString(safeURL),
		"{{TARGET_HOST}}", html.EscapeString(targetHost),
		"{{SHORT_URL}}", html.EscapeString(shortURL),
		"{{COUNTDOWN}}", fmt.Sprintf("%d", seconds),
		"{{PRIMARY_COLOR}}", primaryColor,
		"{{SECURITY_BADGE}}", securityBadge,
		"{{TARGET_URL_BLOCK}}", targetBlock,
		"{{SAFETY_TIP_BLOCK}}", safetyBlock,
		"{{WECHAT_TIP_BLOCK}}", wechatBlock,
		"{{COUNTDOWN_SCRIPT}}", countdownScript,
	)
	return replacer.Replace(tmpl)
}
