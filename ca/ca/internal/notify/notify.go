package notify

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/wimotek/ca/internal/store"
)

const (
	ChannelEmail      = "email"
	ChannelServerChan = "serverchan"
	ChannelTelegram   = "telegram"
	ChannelWebhook    = "webhook"
)

// ChannelConfig holds channel-specific parameters (secrets encrypted at rest with MasterKey).
type ChannelConfig struct {
	// Email (SMTP)
	SMTPHost     string `json:"smtp_host,omitempty"`
	SMTPPort     int    `json:"smtp_port,omitempty"`
	SMTPUser     string `json:"smtp_user,omitempty"`
	SMTPPassword string `json:"smtp_password,omitempty"`
	FromEmail    string `json:"from_email,omitempty"`
	ToEmails     string `json:"to_emails,omitempty"`
	UseTLS       bool   `json:"use_tls,omitempty"`

	// ServerChan (Server酱 Turbo / Server酱³)
	SendKey    string `json:"sendkey,omitempty"`
	CustomURL  string `json:"custom_url,omitempty"`

	// Telegram Bot
	BotToken string `json:"bot_token,omitempty"`
	ChatID   string `json:"chat_id,omitempty"`

	// Generic Webhook (DingTalk, Feishu, WeCom, Slack, Custom)
	WebhookURL    string `json:"webhook_url,omitempty"`
	WebhookSecret string `json:"webhook_secret,omitempty"`
}

// ScanSummary summarizes one certificate expiry alert scan.
type ScanSummary struct {
	CheckedCerts   int `json:"checked_certs"`
	ExpiringFound  int `json:"expiring_found"`
	AlertsSent     int `json:"alerts_sent"`
	AlertsSkipped  int `json:"alerts_skipped"`
	AlertsFailed   int `json:"alerts_failed"`
}

// Service dispatches certificate expiry notifications across Email, ServerChan, Telegram, and Webhooks.
type Service struct {
	store                *store.Store
	masterKey            []byte
	allowPrivateWebhooks bool
	client               *http.Client
}

// NewService constructs a notification service with encrypted-at-rest channel secrets.
func NewService(st *store.Store, masterKey []byte, allowPrivateWebhooks bool) *Service {
	key := masterKey
	if len(key) != 32 {
		sum := sha256.Sum256(key)
		key = sum[:]
	}
	return &Service{
		store:                st,
		masterKey:            key,
		allowPrivateWebhooks: allowPrivateWebhooks,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// ValidateOutboundURL blocks loopback, private, and cloud metadata destinations unless explicitly permitted.
func ValidateOutboundURL(rawURL string, allowPrivate bool) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return errors.New("only http and https URLs are permitted")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return errors.New("URL host is required")
	}
	if !allowPrivate {
		if host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
			return errors.New("loopback and internal hostnames are blocked")
		}
		if ip := net.ParseIP(host); ip != nil {
			if isPrivateOrMetadataIP(ip) {
				return errors.New("private, loopback, or metadata IP addresses are blocked")
			}
		}
	}
	return nil
}

func isPrivateOrMetadataIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsPrivate() || ip.IsUnspecified() {
		return true
	}
	// Explicit cloud metadata IPv4 check
	if ip.Equal(net.ParseIP("169.254.169.254")) {
		return true
	}
	return false
}

// EncryptConfig encrypts a ChannelConfig using AES-256-GCM.
func (s *Service) EncryptConfig(cfg ChannelConfig) (string, error) {
	raw, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(s.masterKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, raw, nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// DecryptConfig decrypts a stored AES-256-GCM ChannelConfig.
func (s *Service) DecryptConfig(enc string) (ChannelConfig, error) {
	var cfg ChannelConfig
	if strings.TrimSpace(enc) == "" {
		return cfg, nil
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return cfg, err
	}
	block, err := aes.NewCipher(s.masterKey)
	if err != nil {
		return cfg, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return cfg, err
	}
	if len(raw) < gcm.NonceSize() {
		return cfg, errors.New("encrypted config truncated")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return cfg, err
	}
	err = json.Unmarshal(plain, &cfg)
	return cfg, err
}

// MaskConfig returns a safe JSON summary with secrets redacted for API responses.
func MaskConfig(channelType string, cfg ChannelConfig) string {
	m := map[string]any{}
	switch channelType {
	case ChannelEmail:
		m["smtp_host"] = cfg.SMTPHost
		m["smtp_port"] = cfg.SMTPPort
		m["smtp_user"] = cfg.SMTPUser
		m["from_email"] = cfg.FromEmail
		m["to_emails"] = cfg.ToEmails
		m["use_tls"] = cfg.UseTLS
		if cfg.SMTPPassword != "" {
			m["smtp_password"] = maskSecret(cfg.SMTPPassword)
		}
	case ChannelServerChan:
		m["sendkey"] = maskSecret(cfg.SendKey)
		if cfg.CustomURL != "" {
			m["custom_url"] = cfg.CustomURL
		}
	case ChannelTelegram:
		m["bot_token"] = maskSecret(cfg.BotToken)
		m["chat_id"] = cfg.ChatID
	case ChannelWebhook:
		m["webhook_url"] = cfg.WebhookURL
		if cfg.WebhookSecret != "" {
			m["webhook_secret"] = maskSecret(cfg.WebhookSecret)
		}
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func maskSecret(v string) string {
	s := strings.TrimSpace(v)
	if len(s) <= 4 {
		if s == "" {
			return ""
		}
		return "****"
	}
	return "****" + s[len(s)-4:]
}

// SaveChannel validates, encrypts, and stores a notification channel.
func (s *Service) SaveChannel(ctx context.Context, id, name, channelType string, cfg ChannelConfig, advanceDays []int, enabled bool) (*store.NotificationChannelRecord, error) {
	chType := strings.ToLower(strings.TrimSpace(channelType))
	if chType != ChannelEmail && chType != ChannelServerChan && chType != ChannelTelegram && chType != ChannelWebhook {
		return nil, fmt.Errorf("unsupported notification channel type %q", channelType)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("channel name is required")
	}

	// Preserve existing secrets if updating without re-entering secrets
	if id != "" {
		if existing, err := s.store.GetNotificationChannel(ctx, id); err == nil && existing != nil {
			if prev, err := s.DecryptConfig(existing.ConfigEnc); err == nil {
				if cfg.SMTPPassword == "" {
					cfg.SMTPPassword = prev.SMTPPassword
				}
				if cfg.SendKey == "" {
					cfg.SendKey = prev.SendKey
				}
				if cfg.BotToken == "" {
					cfg.BotToken = prev.BotToken
				}
				if cfg.WebhookSecret == "" {
					cfg.WebhookSecret = prev.WebhookSecret
				}
			}
		}
	}

	switch chType {
	case ChannelEmail:
		if strings.TrimSpace(cfg.SMTPHost) == "" || strings.TrimSpace(cfg.ToEmails) == "" {
			return nil, errors.New("smtp_host and to_emails are required for email channel")
		}
		if cfg.SMTPPort <= 0 {
			cfg.SMTPPort = 587
		}
	case ChannelServerChan:
		if strings.TrimSpace(cfg.SendKey) == "" {
			return nil, errors.New("sendkey is required for ServerChan channel")
		}
		if cfg.CustomURL != "" {
			if err := ValidateOutboundURL(cfg.CustomURL, s.allowPrivateWebhooks); err != nil {
				return nil, fmt.Errorf("invalid ServerChan URL: %w", err)
			}
		}
	case ChannelTelegram:
		if strings.TrimSpace(cfg.BotToken) == "" || strings.TrimSpace(cfg.ChatID) == "" {
			return nil, errors.New("bot_token and chat_id are required for Telegram channel")
		}
	case ChannelWebhook:
		if err := ValidateOutboundURL(cfg.WebhookURL, s.allowPrivateWebhooks); err != nil {
			return nil, fmt.Errorf("invalid webhook URL: %w", err)
		}
	}

	cleanDays := normalizeAdvanceDays(advanceDays)
	daysJSON, _ := json.Marshal(cleanDays)
	enc, err := s.EncryptConfig(cfg)
	if err != nil {
		return nil, err
	}
	rec := store.NotificationChannelRecord{
		ID:              id,
		Name:            name,
		ChannelType:     chType,
		ConfigEnc:       enc,
		ConfigMasked:    MaskConfig(chType, cfg),
		AdvanceDaysJSON: string(daysJSON),
		Enabled:         enabled,
	}
	if rec.ID == "" {
		rec.ID = store.GenerateRandomID(8)
	}
	if err := s.store.UpsertNotificationChannel(ctx, rec); err != nil {
		return nil, err
	}
	return s.store.GetNotificationChannel(ctx, rec.ID)
}

func normalizeAdvanceDays(days []int) []int {
	seen := map[int]struct{}{}
	out := make([]int, 0, len(days))
	for _, d := range days {
		if d >= 1 && d <= 365 {
			if _, ok := seen[d]; !ok {
				seen[d] = struct{}{}
				out = append(out, d)
			}
		}
	}
	if len(out) == 0 {
		out = []int{30, 7, 1}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(out)))
	return out
}

// SendTest sends a test message via a saved channel and records the result.
func (s *Service) SendTest(ctx context.Context, channelID string) (*store.NotificationLogRecord, error) {
	ch, err := s.store.GetNotificationChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, errors.New("notification channel not found")
	}
	cfg, err := s.DecryptConfig(ch.ConfigEnc)
	if err != nil {
		return nil, err
	}
	title := "[wimotek/ca] Test Expiry Notification"
	body := fmt.Sprintf("Notification channel %q (%s) is active and ready for certificate expiration monitoring.", ch.Name, ch.ChannelType)

	status, msg := s.dispatch(ctx, ch.ChannelType, cfg, title, body)
	logRec := store.NotificationLogRecord{
		ID:            store.GenerateRandomID(10),
		ChannelID:     ch.ID,
		ChannelName:   ch.Name,
		ChannelType:   ch.ChannelType,
		CertSerial:    "TEST",
		CertCN:        "Test Notification",
		ThresholdDays: 0,
		Status:        status,
		Message:       msg,
		SentAt:        time.Now().Unix(),
	}
	_ = s.store.RecordNotificationLog(ctx, logRec)
	return &logRec, nil
}

// RelayChannelResult captures one channel forwarding result for a personal webhook relay event.
type RelayChannelResult struct {
	ChannelID   string `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	ChannelType string `json:"channel_type"`
	Status      string `json:"status"`
	Message     string `json:"message"`
}

// DispatchRelay forwards an incoming webhook message (ServerChan format) to all enabled notification channels.
func (s *Service) DispatchRelay(ctx context.Context, username, title, body, channelFilter string) ([]RelayChannelResult, error) {
	channels, err := s.store.ListNotificationChannels(ctx)
	if err != nil {
		return nil, err
	}
	filter := strings.ToLower(strings.TrimSpace(channelFilter))
	results := make([]RelayChannelResult, 0)
	for _, ch := range channels {
		if !ch.Enabled {
			continue
		}
		if filter != "" && strings.ToLower(ch.ChannelType) != filter && strings.ToLower(ch.ID) != filter && strings.ToLower(ch.Name) != filter {
			continue
		}
		cfg, err := s.DecryptConfig(ch.ConfigEnc)
		if err != nil {
			results = append(results, RelayChannelResult{
				ChannelID:   ch.ID,
				ChannelName: ch.Name,
				ChannelType: ch.ChannelType,
				Status:      "failed",
				Message:     err.Error(),
			})
			continue
		}
		status, msg := s.dispatch(ctx, ch.ChannelType, cfg, title, body)
		logRec := store.NotificationLogRecord{
			ID:            store.GenerateRandomID(10),
			ChannelID:     ch.ID,
			ChannelName:   ch.Name,
			ChannelType:   ch.ChannelType,
			CertSerial:    "webhook:" + username,
			CertCN:        title,
			ThresholdDays: 0,
			Status:        status,
			Message:       msg,
			SentAt:        time.Now().Unix(),
		}
		_ = s.store.RecordNotificationLog(ctx, logRec)
		results = append(results, RelayChannelResult{
			ChannelID:   ch.ID,
			ChannelName: ch.Name,
			ChannelType: ch.ChannelType,
			Status:      status,
			Message:     msg,
		})
	}
	return results, nil
}

// ScanExpiringCertificates evaluates all active certificates against enabled channel thresholds and dispatches deduplicated alerts.
func (s *Service) ScanExpiringCertificates(ctx context.Context) (*ScanSummary, error) {
	certs, err := s.store.ListCertificates(ctx)
	if err != nil {
		return nil, err
	}
	channels, err := s.store.ListNotificationChannels(ctx)
	if err != nil {
		return nil, err
	}

	now := time.Now().Unix()
	summary := &ScanSummary{CheckedCerts: len(certs)}

	for _, cert := range certs {
		if cert.Status != "active" || cert.NotAfter <= now {
			continue
		}
		remainingDays := int((cert.NotAfter - now + 86399) / 86400)
		matchedCert := false

		for _, ch := range channels {
			if !ch.Enabled {
				continue
			}
			var thresholds []int
			_ = json.Unmarshal([]byte(ch.AdvanceDaysJSON), &thresholds)
			thresholds = normalizeAdvanceDays(thresholds)

			// Pick the tightest (smallest) threshold >= remainingDays
			matchedThreshold := 0
			for _, t := range thresholds {
				if remainingDays <= t {
					matchedThreshold = t
				}
			}
			if matchedThreshold == 0 {
				continue
			}
			matchedCert = true

			sent, err := s.store.HasNotificationBeenSent(ctx, ch.ID, cert.SerialHex, matchedThreshold)
			if err == nil && sent {
				summary.AlertsSkipped++
				continue
			}

			cfg, err := s.DecryptConfig(ch.ConfigEnc)
			if err != nil {
				summary.AlertsFailed++
				continue
			}

			expStr := time.Unix(cert.NotAfter, 0).UTC().Format("2006-01-02 15:04 UTC")
			title := fmt.Sprintf("[wimotek/ca] Certificate Expiring in %d Day(s): %s", remainingDays, cert.CommonName)
			body := fmt.Sprintf(
				"Certificate CN=%s (Profile: %s, Serial: %s, Owner: %s) will expire on %s (%d days remaining, threshold: <=%dd). Please renew or reissue before expiry.",
				cert.CommonName, cert.Profile, cert.SerialHex, cert.IssuedBy, expStr, remainingDays, matchedThreshold,
			)

			status, msg := s.dispatch(ctx, ch.ChannelType, cfg, title, body)
			_ = s.store.RecordNotificationLog(ctx, store.NotificationLogRecord{
				ChannelID:     ch.ID,
				ChannelName:   ch.Name,
				ChannelType:   ch.ChannelType,
				CertSerial:    cert.SerialHex,
				CertCN:        cert.CommonName,
				ThresholdDays: matchedThreshold,
				Status:        status,
				Message:       msg,
				SentAt:        now,
			})
			if status == "failed" {
				summary.AlertsFailed++
			} else {
				summary.AlertsSent++
			}
		}

		if matchedCert {
			summary.ExpiringFound++
		}
	}

	return summary, nil
}

// StartScheduler periodically runs ScanExpiringCertificates until ctx is canceled.
func (s *Service) StartScheduler(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Hour
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, _ = s.ScanExpiringCertificates(ctx)
			}
		}
	}()
}

func (s *Service) dispatch(ctx context.Context, chType string, cfg ChannelConfig, title, body string) (string, string) {
	var err error
	switch chType {
	case ChannelEmail:
		err = s.sendEmail(cfg, title, body)
	case ChannelServerChan:
		err = s.sendServerChan(ctx, cfg, title, body)
	case ChannelTelegram:
		err = s.sendTelegram(ctx, cfg, title, body)
	case ChannelWebhook:
		err = s.sendWebhook(ctx, cfg, title, body)
	default:
		err = fmt.Errorf("unsupported channel type %q", chType)
	}
	if err != nil {
		return "failed", err.Error()
	}
	return "sent", title
}

func (s *Service) sendEmail(cfg ChannelConfig, subject, body string) error {
	addr := fmt.Sprintf("%s:%d", cfg.SMTPHost, cfg.SMTPPort)
	from := strings.TrimSpace(cfg.FromEmail)
	if from == "" {
		from = cfg.SMTPUser
	}
	var recipients []string
	for _, r := range strings.Split(cfg.ToEmails, ",") {
		if trimmed := strings.TrimSpace(r); trimmed != "" {
			recipients = append(recipients, trimmed)
		}
	}
	if len(recipients) == 0 {
		return errors.New("no recipients configured")
	}
	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n",
		from, strings.Join(recipients, ", "), subject, body)

	var auth smtp.Auth
	if cfg.SMTPUser != "" {
		auth = smtp.PlainAuth("", cfg.SMTPUser, cfg.SMTPPassword, cfg.SMTPHost)
	}
	if cfg.UseTLS && cfg.SMTPPort == 465 {
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", addr, &tls.Config{
			ServerName: cfg.SMTPHost,
			MinVersion: tls.VersionTLS12,
		})
		if err != nil {
			return err
		}
		c, err := smtp.NewClient(conn, cfg.SMTPHost)
		if err != nil {
			return err
		}
		defer c.Close()
		if auth != nil {
			if err := c.Auth(auth); err != nil {
				return err
			}
		}
		if err := c.Mail(from); err != nil {
			return err
		}
		for _, rcpt := range recipients {
			if err := c.Rcpt(rcpt); err != nil {
				return err
			}
		}
		w, err := c.Data()
		if err != nil {
			return err
		}
		if _, err := w.Write([]byte(msg)); err != nil {
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
		return c.Quit()
	}
	return smtp.SendMail(addr, auth, from, recipients, []byte(msg))
}

func (s *Service) sendServerChan(ctx context.Context, cfg ChannelConfig, title, body string) error {
	endpoint := strings.TrimSpace(cfg.CustomURL)
	if endpoint == "" {
		endpoint = fmt.Sprintf("https://sctapi.ftqq.com/%s.send", url.PathEscape(strings.TrimSpace(cfg.SendKey)))
	}
	if err := ValidateOutboundURL(endpoint, s.allowPrivateWebhooks); err != nil {
		return err
	}
	form := url.Values{}
	form.Set("title", title)
	form.Set("desp", body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("serverchan HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

func (s *Service) sendTelegram(ctx context.Context, cfg ChannelConfig, title, body string) error {
	endpoint := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", url.PathEscape(strings.TrimSpace(cfg.BotToken)))
	payload, _ := json.Marshal(map[string]any{
		"chat_id": strings.TrimSpace(cfg.ChatID),
		"text":    title + "\n\n" + body,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("telegram HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

func (s *Service) sendWebhook(ctx context.Context, cfg ChannelConfig, title, body string) error {
	if err := ValidateOutboundURL(cfg.WebhookURL, s.allowPrivateWebhooks); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{
		"event":   "certificate.expiring",
		"title":   title,
		"text":    title + "\n" + body,
		"msgtype": "text",
		"content": map[string]string{"text": title + "\n" + body},
		"sent_at": time.Now().Unix(),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.WebhookURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if cfg.WebhookSecret != "" {
		mac := hmac.New(sha256.New, []byte(cfg.WebhookSecret))
		mac.Write(payload)
		req.Header.Set("X-Wimotek-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("webhook HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}
