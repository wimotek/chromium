package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

const (
	captchaAlphabet              = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	captchaCodeLength            = 6
	captchaTTL                   = 120 * time.Second
	captchaMinSolveMs            = 1200
	captchaSliderTriggerFailures = 2
)

// SliderPoint captures a human pointer trajectory sample during slider alignment.
type SliderPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	T float64 `json:"t"`
}

// CaptchaChallengeResponse is returned to the client by GET /api/auth/challenge.
// Note: No plaintext answer or <text> SVG element is ever exposed.
type CaptchaChallengeResponse struct {
	ChallengeToken    string `json:"challengeToken"`
	CaptchaSvgDataURI string `json:"captchaSvgDataUri"`
	PowSalt           string `json:"powSalt"`
	PowDifficulty     int    `json:"powDifficulty"`
	RequireSlider     bool   `json:"requireSlider"`
	SliderTarget      int    `json:"sliderTarget"`
	ExpiresInSec      int    `json:"expiresInSec"`
}

// CaptchaVerifyRequest contains the 4-layer anti-AI verification submission.
type CaptchaVerifyRequest struct {
	ChallengeToken   string        `json:"challengeToken"`
	CaptchaCode      string        `json:"captchaCode"`
	PowNonce         string        `json:"powNonce"`
	SliderPosition   float64       `json:"sliderPosition"`
	SliderDurationMs float64       `json:"sliderDurationMs"`
	SliderTrail      []SliderPoint `json:"sliderTrail"`
	Honeypot         string        `json:"website"`
	ClientIP         string        `json:"-"`
}

type captchaTokenPayload struct {
	Nonce         string `json:"n"`
	CodeHash      string `json:"h"`
	PowSalt       string `json:"ps"`
	PowDifficulty int    `json:"pd"`
	RequireSlider bool   `json:"rs"`
	SliderTarget  int    `json:"st"`
	IPHash        string `json:"ip"`
	IssuedAtMs    int64  `json:"iat"`
	ExpiresAtMs   int64  `json:"exp"`
}

// Normalized 0..100 vector stroke font (rendered exclusively as warped SVG <path> strokes, ZERO <text> tags).
var vectorGlyphs = map[byte][][][2]float64{
	'2': {{{15, 25}, {35, 10}, {72, 10}, {85, 28}, {75, 50}, {15, 88}, {88, 88}}},
	'3': {{{18, 18}, {50, 10}, {82, 22}, {75, 45}, {45, 50}}, {{45, 50}, {82, 58}, {84, 80}, {50, 90}, {16, 82}}},
	'4': {{{72, 90}, {72, 12}, {16, 62}, {88, 62}}},
	'5': {{{82, 12}, {22, 12}, {18, 48}, {55, 44}, {84, 58}, {80, 82}, {48, 90}, {18, 82}}},
	'6': {{{78, 18}, {48, 10}, {20, 32}, {16, 70}, {45, 90}, {80, 80}, {82, 56}, {52, 46}, {18, 56}}},
	'7': {{{15, 14}, {86, 14}, {42, 90}}, {{36, 52}, {72, 52}}},
	'8': {
		{{50, 48}, {22, 36}, {24, 16}, {50, 10}, {76, 16}, {78, 36}, {50, 48}},
		{{50, 48}, {18, 62}, {20, 84}, {50, 90}, {80, 84}, {82, 62}, {50, 48}},
	},
	'9': {{{82, 42}, {52, 52}, {20, 42}, {18, 20}, {50, 10}, {82, 22}, {80, 68}, {50, 90}, {22, 82}}},
	'A': {{{14, 90}, {50, 10}, {86, 90}}, {{28, 62}, {72, 62}}},
	'B': {
		{{20, 12}, {20, 88}},
		{{20, 12}, {65, 12}, {80, 26}, {68, 48}, {20, 48}},
		{{20, 48}, {72, 48}, {86, 68}, {70, 88}, {20, 88}},
	},
	'C': {{{84, 24}, {62, 10}, {32, 14}, {16, 48}, {30, 84}, {62, 90}, {84, 76}}},
	'D': {{{20, 12}, {20, 88}}, {{20, 12}, {58, 12}, {84, 34}, {84, 66}, {58, 88}, {20, 88}}},
	'E': {{{82, 12}, {20, 12}, {20, 88}, {84, 88}}, {{20, 50}, {72, 50}}},
	'F': {{{84, 12}, {20, 12}, {20, 88}}, {{20, 50}, {72, 50}}},
	'G': {{{82, 24}, {58, 10}, {28, 16}, {16, 50}, {28, 84}, {62, 90}, {84, 76}, {84, 52}, {54, 52}}},
	'H': {{{20, 12}, {20, 88}}, {{80, 12}, {80, 88}}, {{20, 50}, {80, 50}}},
	'J': {{{32, 12}, {82, 12}}, {{68, 12}, {68, 72}, {50, 90}, {26, 86}, {16, 70}}},
	'K': {{{20, 12}, {20, 88}}, {{82, 14}, {22, 52}, {84, 88}}},
	'L': {{{22, 12}, {22, 88}, {84, 88}}},
	'M': {{{14, 88}, {18, 12}, {50, 58}, {82, 12}, {86, 88}}},
	'N': {{{18, 88}, {18, 12}, {82, 88}, {82, 12}}},
	'P': {{{20, 88}, {20, 12}, {66, 12}, {84, 28}, {68, 52}, {20, 52}}},
	'Q': {
		{{50, 10}, {20, 24}, {16, 54}, {30, 82}, {62, 88}, {84, 64}, {80, 26}, {50, 10}},
		{{56, 66}, {88, 92}},
	},
	'R': {{{20, 88}, {20, 12}, {66, 12}, {82, 28}, {66, 50}, {20, 50}}, {{50, 50}, {84, 88}}},
	'S': {{{80, 22}, {52, 10}, {22, 20}, {22, 40}, {78, 56}, {80, 80}, {48, 90}, {18, 78}}},
	'T': {{{14, 14}, {86, 14}}, {{50, 14}, {50, 88}}},
	'U': {{{20, 12}, {20, 68}, {38, 88}, {64, 88}, {80, 68}, {80, 12}}},
	'V': {{{16, 14}, {50, 88}, {84, 14}}},
	'W': {{{12, 14}, {28, 88}, {50, 42}, {72, 88}, {88, 14}}},
	'X': {{{18, 14}, {82, 88}}, {{82, 14}, {18, 88}}},
	'Y': {{{16, 14}, {50, 50}, {84, 14}}, {{50, 50}, {50, 88}}},
	'Z': {{{16, 14}, {84, 14}, {16, 88}, {84, 88}}, {{34, 51}, {66, 51}}},
}

func randFloatRange(minVal, maxVal float64) float64 {
	r := cryptoRandInt(0, 10000)
	return minVal + (float64(r)/10000.0)*(maxVal-minVal)
}

func adaptivePowDifficulty(recentFailures int) int {
	switch {
	case recentFailures >= 4:
		return 18
	case recentFailures >= 2:
		return 17
	case recentFailures >= 1:
		return 16
	default:
		return 15
	}
}

func hmacHexShort(secret, msg string, hexLen int) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(msg))
	full := hex.EncodeToString(mac.Sum(nil))
	if hexLen < len(full) {
		return full[:hexLen]
	}
	return full
}

func verifyPowHash(powSalt, powNonce string, difficulty int) bool {
	if powSalt == "" || powNonce == "" || len(powNonce) > 64 || difficulty < 8 || difficulty > 24 {
		return false
	}
	sum := sha256.Sum256([]byte(powSalt + ":" + powNonce))
	fullBytes := difficulty / 8
	remBits := difficulty % 8
	for i := 0; i < fullBytes; i++ {
		if sum[i] != 0 {
			return false
		}
	}
	if remBits > 0 {
		mask := byte(0xff << (8 - remBits))
		if (sum[fullBytes] & mask) != 0 {
			return false
		}
	}
	return true
}

func renderAdversarialSVG(code string) string {
	const width = 320.0
	const height = 96.0
	waveAmp := randFloatRange(2.2, 4.2)
	waveFreq := randFloatRange(0.035, 0.06)
	wavePhase := randFloatRange(0, math.Pi*2)

	fgColors := []string{"#0f172a", "#1d4ed8", "#0f766e", "#7c2d12", "#4338ca"}
	bg1, bg2 := "#f8fafc", "#e2e8f0"
	if cryptoRandInt(0, 1) == 1 {
		bg1, bg2 = "#f1f5f9", "#dbeafe"
	}

	warp := func(x, y float64) (float64, float64) {
		wx := x + math.Sin(y*0.09+wavePhase)*(waveAmp*0.75)
		wy := y + math.Sin(x*waveFreq+wavePhase)*waveAmp
		return wx, wy
	}

	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96" viewBox="0 0 320 96">`)
	fmt.Fprintf(&b, `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%%" stop-color="%s"/><stop offset="100%%" stop-color="%s"/></linearGradient></defs>`, bg1, bg2)
	b.WriteString(`<rect width="320" height="96" rx="8" fill="url(#bg)"/>`)

	// Background warped grid + decoy circles
	for gx := -10; gx < 340; gx += cryptoRandInt(16, 26) {
		skew := cryptoRandInt(-18, 18)
		fmt.Fprintf(&b, `<path d="M%d,0 L%d,96" stroke="#cbd5e1" stroke-width="0.8" opacity="0.55" fill="none"/>`, gx, gx+skew)
	}
	for gy := 10; gy < 96; gy += cryptoRandInt(14, 22) {
		cy1 := gy + cryptoRandInt(-9, 9)
		cy2 := gy + cryptoRandInt(-9, 9)
		fmt.Fprintf(&b, `<path d="M0,%d C106,%d 213,%d 320,%d" stroke="#cbd5e1" stroke-width="0.8" opacity="0.5" fill="none"/>`, gy, cy1, cy2, gy)
	}
	for i := 0; i < 14; i++ {
		cx := cryptoRandInt(10, 310)
		cy := cryptoRandInt(10, 86)
		r := cryptoRandInt(5, 16)
		col := fgColors[cryptoRandInt(0, len(fgColors)-1)]
		fmt.Fprintf(&b, `<circle cx="%d" cy="%d" r="%d" fill="none" stroke="%s" stroke-width="1" opacity="0.14"/>`, cx, cy, r, col)
	}

	// Render warped vector <path> glyphs (ZERO <text> tags)
	layers := make([]string, 0, len(code))
	slotW := (width - 28.0) / float64(len(code))
	for idx := 0; idx < len(code); idx++ {
		ch := code[idx]
		strokes, ok := vectorGlyphs[ch]
		if !ok {
			strokes = vectorGlyphs['X']
		}
		baseCx := 14.0 + slotW*float64(idx) + slotW*0.5 + randFloatRange(-3.5, 3.5)
		baseCy := height*0.5 + randFloatRange(-6.0, 6.0)
		angleRad := randFloatRange(-22.0, 22.0) * math.Pi / 180.0
		shearX := randFloatRange(-0.22, 0.22)
		scaleX := randFloatRange(0.36, 0.44)
		scaleY := randFloatRange(0.46, 0.56)
		col := fgColors[cryptoRandInt(0, len(fgColors)-1)]
		strokeW := randFloatRange(3.4, 4.4)

		transformPt := func(px, py float64) (float64, float64) {
			lx := (px - 50.0) * scaleX
			ly := (py - 50.0) * scaleY
			sx := lx + shearX*ly
			rx := sx*math.Cos(angleRad) - ly*math.Sin(angleRad)
			ry := sx*math.Sin(angleRad) + ly*math.Cos(angleRad)
			return warp(baseCx+rx+randFloatRange(-0.9, 0.9), baseCy+ry+randFloatRange(-0.9, 0.9))
		}

		var lb strings.Builder
		lb.WriteString("<g>")
		for _, poly := range strokes {
			if len(poly) < 2 {
				continue
			}
			var pb strings.Builder
			ptIndex := 0
			for s := 0; s < len(poly)-1; s++ {
				x0, y0 := poly[s][0], poly[s][1]
				x1, y1 := poly[s+1][0], poly[s+1][1]
				for k := 0; k < 4; k++ {
					t := float64(k) / 4.0
					wx, wy := transformPt(x0+(x1-x0)*t, y0+(y1-y0)*t)
					if ptIndex == 0 {
						fmt.Fprintf(&pb, "M%.1f,%.1f", wx, wy)
					} else {
						fmt.Fprintf(&pb, " L%.1f,%.1f", wx, wy)
					}
					ptIndex++
				}
			}
			last := poly[len(poly)-1]
			wx, wy := transformPt(last[0], last[1])
			fmt.Fprintf(&pb, " L%.1f,%.1f", wx, wy)
			d := pb.String()

			echoDx := randFloatRange(-1.6, 1.6)
			echoDy := randFloatRange(-1.6, 1.6)
			fmt.Fprintf(&lb, `<path d="%s" transform="translate(%.1f,%.1f)" fill="none" stroke="%s" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.28"/>`, d, echoDx, echoDy, col)
			fmt.Fprintf(&lb, `<path d="%s" fill="none" stroke="%s" stroke-width="%.1f" stroke-linecap="round" stroke-linejoin="round"/>`, d, col, strokeW)
		}
		lb.WriteString("</g>")
		layers = append(layers, lb.String())
	}

	// Shuffle SVG draw order so DOM order != visual reading order
	for i := len(layers) - 1; i > 0; i-- {
		j := cryptoRandInt(0, i)
		layers[i], layers[j] = layers[j], layers[i]
	}
	for _, layer := range layers {
		b.WriteString(layer)
	}

	// Foreground crossing adversarial bezier curves + speckles
	for i := 0; i < 6; i++ {
		yStart := cryptoRandInt(8, 88)
		yEnd := cryptoRandInt(8, 88)
		c1x := cryptoRandInt(40, 140)
		c1y := cryptoRandInt(4, 92)
		c2x := cryptoRandInt(160, 280)
		c2y := cryptoRandInt(4, 92)
		col := fgColors[cryptoRandInt(0, len(fgColors)-1)]
		sw := randFloatRange(1.2, 2.1)
		fmt.Fprintf(&b, `<path d="M0,%d C%d,%d %d,%d 320,%d" fill="none" stroke="%s" stroke-width="%.1f" opacity="0.52"/>`, yStart, c1x, c1y, c2x, c2y, yEnd, col, sw)
	}
	for i := 0; i < 42; i++ {
		dx := cryptoRandInt(4, 316)
		dy := cryptoRandInt(4, 92)
		r := randFloatRange(0.9, 2.2)
		col := fgColors[cryptoRandInt(0, len(fgColors)-1)]
		fmt.Fprintf(&b, `<circle cx="%d" cy="%d" r="%.1f" fill="%s" opacity="0.45"/>`, dx, dy, r, col)
	}
	b.WriteString("</svg>")

	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(b.String()))
}

// CreateHighStrengthChallenge builds a 4-layer Anti-AI challenge bound to the client IP.
func (s *Service) CreateHighStrengthChallenge(clientIP string, recentFailedAttempts int) CaptchaChallengeResponse {
	secret := s.cfg.Get().SessionSecret
	var codeBuilder strings.Builder
	for i := 0; i < captchaCodeLength; i++ {
		codeBuilder.WriteByte(captchaAlphabet[cryptoRandInt(0, len(captchaAlphabet)-1)])
	}
	code := codeBuilder.String()
	nonce := RandomToken(10)
	powSalt := RandomToken(10)
	powDiff := adaptivePowDifficulty(recentFailedAttempts)
	requireSlider := recentFailedAttempts >= captchaSliderTriggerFailures
	sliderTarget := 0
	if requireSlider {
		sliderTarget = cryptoRandInt(54, 88)
	}
	nowMs := time.Now().UnixMilli()

	payload := captchaTokenPayload{
		Nonce:         nonce,
		CodeHash:      hmacHexShort(secret, "ans:"+nonce+":"+code, 24),
		PowSalt:       powSalt,
		PowDifficulty: powDiff,
		RequireSlider: requireSlider,
		SliderTarget:  sliderTarget,
		IPHash:        hmacHexShort(secret, "ip:"+clientIP, 16),
		IssuedAtMs:    nowMs,
		ExpiresAtMs:   nowMs + captchaTTL.Milliseconds(),
	}
	raw, _ := json.Marshal(payload)
	enc := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("cap2:" + enc))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return CaptchaChallengeResponse{
		ChallengeToken:    enc + "." + sig,
		CaptchaSvgDataURI: renderAdversarialSVG(code),
		PowSalt:           powSalt,
		PowDifficulty:     powDiff,
		RequireSlider:     requireSlider,
		SliderTarget:      sliderTarget,
		ExpiresInSec:      int(captchaTTL.Seconds()),
	}
}

// VerifyHighStrengthChallenge validates all 4 anti-AI layers and immediately burns the nonce.
func (s *Service) VerifyHighStrengthChallenge(req CaptchaVerifyRequest) error {
	if strings.TrimSpace(req.Honeypot) != "" {
		s.RecordBlocked()
		return errors.New("检测到自动化填充行为，请求已被拦截")
	}

	parts := strings.Split(strings.TrimSpace(req.ChallengeToken), ".")
	if len(parts) != 2 {
		s.RecordBlocked()
		return errors.New("请先刷新并完成高强度人机防刷验证")
	}

	secret := s.cfg.Get().SessionSecret
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("cap2:" + parts[0]))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[1]), []byte(expectedSig)) {
		s.RecordBlocked()
		return errors.New("人机验证签名无效，请刷新重试")
	}

	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		s.RecordBlocked()
		return errors.New("人机验证载荷损坏，请刷新重试")
	}
	var payload captchaTokenPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		s.RecordBlocked()
		return errors.New("人机验证数据解析失败，请刷新重试")
	}

	nowMs := time.Now().UnixMilli()
	if nowMs > payload.ExpiresAtMs {
		return errors.New("验证码已过期（120秒有效），请刷新重试")
	}

	// Single-use burn on first verification attempt (prevents brute-forcing or replaying a challenge)
	s.challengeMu.Lock()
	now := time.Now()
	for k, exp := range s.usedChallenges {
		if now.After(exp) {
			delete(s.usedChallenges, k)
		}
	}
	if _, used := s.usedChallenges[payload.Nonce]; used {
		s.challengeMu.Unlock()
		s.RecordBlocked()
		return errors.New("该验证码已使用或作废，请刷新重试")
	}
	s.usedChallenges[payload.Nonce] = time.UnixMilli(payload.ExpiresAtMs)
	s.challengeMu.Unlock()

	// Strict IP binding
	expectedIPHash := hmacHexShort(secret, "ip:"+req.ClientIP, 16)
	if !hmac.Equal([]byte(payload.IPHash), []byte(expectedIPHash)) {
		s.RecordBlocked()
		return errors.New("验证码与当前网络环境不匹配，请刷新重试")
	}

	// Minimum human interaction latency gate
	if nowMs-payload.IssuedAtMs < captchaMinSolveMs {
		s.RecordBlocked()
		return errors.New("提交过快，疑似 AI 扫描或机器人行为，请重试")
	}

	// Layer 1: SHA-256 Proof-of-Work
	if !verifyPowHash(payload.PowSalt, strings.TrimSpace(req.PowNonce), payload.PowDifficulty) {
		s.RecordBlocked()
		return errors.New("浏览器安全算力校验未通过，请刷新重试")
	}

	// Layer 2: Adaptive interactive human slider alignment + trajectory verification (enforced after repeated failures)
	if payload.RequireSlider {
		if math.Abs(req.SliderPosition-float64(payload.SliderTarget)) > 6.0 {
			s.RecordBlocked()
			return errors.New("请将滑块准确拖动至目标校验区间")
		}
		if req.SliderDurationMs < 120 || req.SliderDurationMs > 30000 || len(req.SliderTrail) < 4 {
			s.RecordBlocked()
			return errors.New("滑块交互轨迹异常，疑似自动化脚本，请重试")
		}
		first := req.SliderTrail[0]
		last := req.SliderTrail[len(req.SliderTrail)-1]
		if math.Abs(last.X-first.X) < 15 || (last.T-first.T) < 80 {
			s.RecordBlocked()
			return errors.New("滑动轨迹速率异常（疑似机器人），请重新验证")
		}
	}

	// Layer 3: Distorted 6-char visual code verification
	cleanCode := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(req.CaptchaCode), " ", ""))
	if len(cleanCode) != captchaCodeLength {
		s.RecordBlocked()
		return errors.New("请输入完整的 6 位图形验证码")
	}
	actualHash := hmacHexShort(secret, "ans:"+payload.Nonce+":"+cleanCode, 24)
	if !hmac.Equal([]byte(actualHash), []byte(payload.CodeHash)) {
		s.RecordBlocked()
		return errors.New("图形验证码输入错误，已自动作废，请刷新重试")
	}

	return nil
}
