package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	challengeTTL          = 3 * time.Minute
	minHumanSubmitDelay   = 600 * time.Millisecond
	maxActiveChallenges   = 1024
	basePowDifficulty     = 14 // ~15-40ms in modern browsers; exponentially harder on repeated failures
	maxPowDifficulty      = 20
	challengeRateLimit    = 30
	challengeRateWindow   = 2 * time.Minute
	ipFailureResetAfter   = 30 * time.Minute
)

// 去除易混淆字符 (0/O/1/I/L)
const captchaAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

type challengeRecord struct {
	id         string
	ip         string
	salt       string
	difficulty int
	answer     string
	issuedAt   time.Time
	expiresAt  time.Time
}

type ipShieldState struct {
	failures      int
	lockedUntil   time.Time
	lastFailureAt time.Time
	reqCount      int
	reqWindowEnd  time.Time
}

// ChallengePayload 下发给浏览器的防机器人挑战（绝不含明文答案）
type ChallengePayload struct {
	ChallengeID  string `json:"challenge_id"`
	Salt         string `json:"salt"`
	Difficulty   int    `json:"difficulty"`
	CaptchaImage string `json:"captcha_image"`
	ExpiresIn    int    `json:"expires_in"`
	RetryAfter   int    `json:"retry_after,omitempty"`
}

// GuardStats 后台安全盾实时统计
type GuardStats struct {
	BlockedAttempts  int64 `json:"blocked_attempts"`
	LockedIPs        int   `json:"locked_ips"`
	ActiveChallenges int   `json:"active_challenges"`
	BasePowBits      int   `json:"base_pow_bits"`
	MaxPowBits       int   `json:"max_pow_bits"`
}

// Guard 高强度登录防机器人 + 防爆破防刷引擎（SVG 扭曲验证码 + 动态 SHA-256 PoW + 蜜罐 + 阶梯锁定）
type Guard struct {
	mu              sync.Mutex
	trustProxy      bool
	challenges      map[string]*challengeRecord
	ipStates        map[string]*ipShieldState
	blockedAttempts int64
}

func NewGuard(trustProxy bool) *Guard {
	return &Guard{
		trustProxy: trustProxy,
		challenges: make(map[string]*challengeRecord),
		ipStates:   make(map[string]*ipShieldState),
	}
}

// ClientIP 提取客户端真实 IP（默认仅信任 RemoteAddr，仅当 TRUST_PROXY=true 时读取代理头，防止伪造头绕过防刷）
func (g *Guard) ClientIP(r *http.Request) string {
	if g.trustProxy {
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			first := strings.TrimSpace(strings.Split(xff, ",")[0])
			if net.ParseIP(first) != nil {
				return first
			}
		}
		if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
			if net.ParseIP(xri) != nil {
				return xri
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// IssueChallenge 签发一次性 SVG 扭曲验证码 + 动态难度 SHA-256 PoW 挑战
func (g *Guard) IssueChallenge(ip string) (ChallengePayload, int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now()
	g.pruneExpiredLocked(now)

	st := g.getOrCreateIPStateLocked(ip, now)
	if now.After(st.reqWindowEnd) {
		st.reqCount = 0
		st.reqWindowEnd = now.Add(challengeRateWindow)
	}
	if st.reqCount >= challengeRateLimit {
		g.blockedAttempts++
		retry := int(time.Until(st.reqWindowEnd).Seconds()) + 1
		if retry < 1 {
			retry = 1
		}
		return ChallengePayload{RetryAfter: retry}, retry, fmt.Errorf("验证码请求过于频繁，请 %d 秒后重试", retry)
	}
	st.reqCount++

	difficulty := g.computeDifficultyLocked(st)
	id, err := randomHexBytes(16)
	if err != nil {
		return ChallengePayload{}, 0, err
	}
	salt, err := randomHexBytes(12)
	if err != nil {
		return ChallengePayload{}, 0, err
	}
	answer := randomCaptchaCode(4)
	svg := renderDistortedCaptchaSVG(answer)
	dataURI := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))

	// 限制内存中的挑战总数，防止恶意洪泛
	if len(g.challenges) >= maxActiveChallenges {
		var oldestID string
		var oldestTime time.Time
		for k, v := range g.challenges {
			if oldestID == "" || v.issuedAt.Before(oldestTime) {
				oldestID = k
				oldestTime = v.issuedAt
			}
		}
		if oldestID != "" {
			delete(g.challenges, oldestID)
		}
	}

	g.challenges[id] = &challengeRecord{
		id:         id,
		ip:         ip,
		salt:       salt,
		difficulty: difficulty,
		answer:     answer,
		issuedAt:   now,
		expiresAt:  now.Add(challengeTTL),
	}

	retry := 0
	if now.Before(st.lockedUntil) {
		retry = int(time.Until(st.lockedUntil).Seconds()) + 1
	}

	return ChallengePayload{
		ChallengeID:  id,
		Salt:         salt,
		Difficulty:   difficulty,
		CaptchaImage: dataURI,
		ExpiresIn:    int(challengeTTL.Seconds()),
		RetryAfter:   retry,
	}, 0, nil
}

// VerifySubmission 严格校验登录防机器人挑战（锁定检查 -> 蜜罐 -> 一次性挑战 -> 停留时延 -> 图形验证码 -> SHA-256 PoW）
// 返回值 retryAfter > 0 表示触发 429 锁定冷却
func (g *Guard) VerifySubmission(ip, challengeID, captchaAnswer, powNonce, honeypot string) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now()
	g.pruneExpiredLocked(now)
	st := g.getOrCreateIPStateLocked(ip, now)

	// 1. 检查 IP 是否处于阶梯封禁冷却期
	if now.Before(st.lockedUntil) {
		g.blockedAttempts++
		retry := int(time.Until(st.lockedUntil).Seconds()) + 1
		return retry, fmt.Errorf("触发高频防刷保护，当前 IP 已锁定，请 %d 秒后再试", retry)
	}

	// 2. 蜜罐字段检测：人类不可见，任何填充均判定为机器人
	if strings.TrimSpace(honeypot) != "" {
		retry := g.recordFailureLocked(st, now, 2)
		g.blockedAttempts++
		return retry, fmt.Errorf("检测到自动化异常提交，请求已拦截")
	}

	// 3. 一次性消费挑战（无论后续校验成功与否，立刻作废杜绝重放）
	cid := strings.TrimSpace(challengeID)
	rec, ok := g.challenges[cid]
	if ok {
		delete(g.challenges, cid)
	}
	if !ok || now.After(rec.expiresAt) || rec.ip != ip {
		retry := g.recordFailureLocked(st, now, 1)
		g.blockedAttempts++
		return retry, fmt.Errorf("安全验证已过期或失效，请刷新验证码后重试")
	}

	// 4. 最小人工停留时延（阻断毫秒级脚本直接回放）
	if now.Sub(rec.issuedAt) < minHumanSubmitDelay {
		retry := g.recordFailureLocked(st, now, 1)
		g.blockedAttempts++
		return retry, fmt.Errorf("提交速度异常过快，请重新输入验证码后再试")
	}

	// 5. 图形验证码常量时间比对（不区分大小写）
	gotAns := strings.ToUpper(strings.TrimSpace(captchaAnswer))
	if len(gotAns) != len(rec.answer) || subtle.ConstantTimeCompare([]byte(gotAns), []byte(rec.answer)) != 1 {
		retry := g.recordFailureLocked(st, now, 1)
		g.blockedAttempts++
		return retry, fmt.Errorf("图形验证码错误，请重新输入")
	}

	// 6. 校验 SHA-256 Proof-of-Work（前 difficulty 位必须全为 0）
	nonce := strings.TrimSpace(powNonce)
	if len(nonce) == 0 || len(nonce) > 64 || !VerifyPoW(rec.id, rec.salt, nonce, rec.difficulty) {
		retry := g.recordFailureLocked(st, now, 1)
		g.blockedAttempts++
		return retry, fmt.Errorf("安全算力校验未通过，请刷新页面后重试")
	}

	return 0, nil
}

// RecordAuthFailure 凭证错误时累加失败计数并按阶梯升级冷却锁定
func (g *Guard) RecordAuthFailure(ip string) (int, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	st := g.getOrCreateIPStateLocked(ip, now)
	retry := g.recordFailureLocked(st, now, 1)
	g.blockedAttempts++
	return st.failures, retry
}

// RecordAuthSuccess 登录成功后清零该 IP 的失败惩罚计数
func (g *Guard) RecordAuthSuccess(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if st, ok := g.ipStates[ip]; ok {
		st.failures = 0
		st.lockedUntil = time.Time{}
	}
}

// Stats 返回防刷安全盾实时状态
func (g *Guard) Stats() GuardStats {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	g.pruneExpiredLocked(now)

	locked := 0
	for _, st := range g.ipStates {
		if now.Before(st.lockedUntil) {
			locked++
		}
	}
	return GuardStats{
		BlockedAttempts:  g.blockedAttempts,
		LockedIPs:        locked,
		ActiveChallenges: len(g.challenges),
		BasePowBits:      basePowDifficulty,
		MaxPowBits:       maxPowDifficulty,
	}
}

func (g *Guard) getOrCreateIPStateLocked(ip string, now time.Time) *ipShieldState {
	st, ok := g.ipStates[ip]
	if !ok {
		st = &ipShieldState{reqWindowEnd: now.Add(challengeRateWindow)}
		g.ipStates[ip] = st
		return st
	}
	// 长时间无失败自动宽恕重置
	if st.failures > 0 && now.After(st.lockedUntil) && now.Sub(st.lastFailureAt) > ipFailureResetAfter {
		st.failures = 0
	}
	return st
}

func (g *Guard) computeDifficultyLocked(st *ipShieldState) int {
	diff := basePowDifficulty
	switch {
	case st.failures >= 6:
		diff = maxPowDifficulty
	case st.failures >= 4:
		diff = basePowDifficulty + 4
	case st.failures >= 2:
		diff = basePowDifficulty + 2
	}
	if diff > maxPowDifficulty {
		diff = maxPowDifficulty
	}
	return diff
}

func (g *Guard) recordFailureLocked(st *ipShieldState, now time.Time, weight int) int {
	st.failures += weight
	st.lastFailureAt = now

	var lockout time.Duration
	switch {
	case st.failures >= 12:
		lockout = 60 * time.Minute
	case st.failures >= 8:
		lockout = 15 * time.Minute
	case st.failures >= 5:
		lockout = 60 * time.Second
	case st.failures >= 3:
		lockout = 15 * time.Second
	}
	if lockout > 0 {
		st.lockedUntil = now.Add(lockout)
		return int(lockout.Seconds())
	}
	return 0
}

func (g *Guard) pruneExpiredLocked(now time.Time) {
	for id, rec := range g.challenges {
		if now.After(rec.expiresAt) {
			delete(g.challenges, id)
		}
	}
	if len(g.ipStates) > 4096 {
		for ip, st := range g.ipStates {
			if now.After(st.lockedUntil) && now.After(st.reqWindowEnd) && now.Sub(st.lastFailureAt) > ipFailureResetAfter {
				delete(g.ipStates, ip)
			}
		}
	}
}

// VerifyPoW 校验 SHA-256("challengeID:salt:nonce") 是否具有至少 difficulty 位前导零
func VerifyPoW(challengeID, salt, nonce string, difficulty int) bool {
	if difficulty <= 0 || difficulty > 32 {
		return false
	}
	sum := sha256.Sum256([]byte(challengeID + ":" + salt + ":" + nonce))
	return hasLeadingZeroBits(sum[:], difficulty)
}

func hasLeadingZeroBits(hash []byte, bits int) bool {
	fullBytes := bits / 8
	remBits := bits % 8
	for i := 0; i < fullBytes; i++ {
		if hash[i] != 0 {
			return false
		}
	}
	if remBits > 0 {
		mask := byte(0xff << (8 - remBits))
		if hash[fullBytes]&mask != 0 {
			return false
		}
	}
	return true
}

func cryptoRandInt(max int) int {
	if max <= 1 {
		return 0
	}
	var b [4]byte
	_, _ = rand.Read(b[:])
	return int(binary.BigEndian.Uint32(b[:]) % uint32(max))
}

func randomCaptchaCode(n int) string {
	var sb strings.Builder
	for i := 0; i < n; i++ {
		sb.WriteByte(captchaAlphabet[cryptoRandInt(len(captchaAlphabet))])
	}
	return sb.String()
}

// 矢量字形笔画表（0..10 x 0..14 网格，纯 <path> 渲染，SVG 中不含任何 <text> 或明文字符，彻底阻断正则抓取）
var vectorGlyphs = map[byte][][][2]float64{
	'2': {{{1, 3}, {3, 1}, {7, 1}, {9, 3}, {9, 6}, {1, 13}, {9, 13}}},
	'3': {{{1, 2}, {4, 1}, {8, 2}, {9, 4}, {7, 7}, {4, 7}}, {{7, 7}, {9, 9}, {8, 12}, {4, 13}, {1, 12}}},
	'4': {{{7, 13}, {7, 1}, {1, 9}, {9, 9}}},
	'5': {{{9, 1}, {2, 1}, {1, 6}, {6, 6}, {9, 8}, {9, 11}, {6, 13}, {2, 13}, {1, 11}}},
	'6': {{{8, 2}, {5, 1}, {2, 3}, {1, 8}, {2, 12}, {6, 13}, {9, 11}, {9, 8}, {6, 6}, {2, 7}}},
	'7': {{{1, 1}, {9, 1}, {4, 13}}},
	'8': {{{5, 7}, {2, 5}, {2, 2}, {5, 1}, {8, 2}, {8, 5}, {5, 7}, {1, 9}, {1, 12}, {5, 13}, {9, 12}, {9, 9}, {5, 7}}},
	'9': {{{8, 6}, {5, 8}, {2, 7}, {1, 4}, {3, 1}, {7, 1}, {9, 4}, {8, 10}, {5, 13}, {2, 12}}},
	'A': {{{1, 13}, {5, 1}, {9, 13}}, {{2.5, 9}, {7.5, 9}}},
	'B': {{{1, 1}, {1, 13}}, {{1, 1}, {6, 1}, {8, 3}, {8, 5}, {6, 7}, {1, 7}}, {{1, 7}, {7, 7}, {9, 9}, {9, 11}, {7, 13}, {1, 13}}},
	'C': {{{9, 3}, {7, 1}, {3, 1}, {1, 4}, {1, 10}, {3, 13}, {7, 13}, {9, 11}}},
	'D': {{{1, 1}, {1, 13}}, {{1, 1}, {6, 1}, {9, 4}, {9, 10}, {6, 13}, {1, 13}}},
	'E': {{{9, 1}, {1, 1}, {1, 13}, {9, 13}}, {{1, 7}, {7, 7}}},
	'F': {{{9, 1}, {1, 1}, {1, 13}}, {{1, 7}, {7, 7}}},
	'G': {{{9, 3}, {7, 1}, {3, 1}, {1, 4}, {1, 10}, {3, 13}, {8, 13}, {9, 10}, {9, 8}, {5, 8}}},
	'H': {{{1, 1}, {1, 13}}, {{9, 1}, {9, 13}}, {{1, 7}, {9, 7}}},
	'J': {{{8, 1}, {8, 10}, {6, 13}, {3, 13}, {1, 11}}},
	'K': {{{1, 1}, {1, 13}}, {{9, 1}, {2, 7}, {9, 13}}},
	'M': {{{1, 13}, {1, 1}, {5, 8}, {9, 1}, {9, 13}}},
	'N': {{{1, 13}, {1, 1}, {9, 13}, {9, 1}}},
	'P': {{{1, 13}, {1, 1}, {6, 1}, {9, 3}, {9, 6}, {6, 8}, {1, 8}}},
	'Q': {{{5, 1}, {2, 3}, {1, 7}, {2, 11}, {5, 13}, {8, 11}, {9, 7}, {8, 3}, {5, 1}}, {{6, 10}, {9.5, 13.5}}},
	'R': {{{1, 13}, {1, 1}, {6, 1}, {9, 3}, {9, 6}, {6, 8}, {1, 8}}, {{5, 8}, {9, 13}}},
	'S': {{{9, 3}, {7, 1}, {3, 1}, {1, 3}, {2, 6}, {8, 8}, {9, 11}, {7, 13}, {3, 13}, {1, 11}}},
	'T': {{{1, 1}, {9, 1}}, {{5, 1}, {5, 13}}},
	'U': {{{1, 1}, {1, 10}, {3, 13}, {7, 13}, {9, 10}, {9, 1}}},
	'V': {{{1, 1}, {5, 13}, {9, 1}}},
	'W': {{{0.5, 1}, {2.5, 13}, {5, 6}, {7.5, 13}, {9.5, 1}}},
	'X': {{{1, 1}, {9, 13}}, {{9, 1}, {1, 13}}},
	'Y': {{{1, 1}, {5, 7}, {9, 1}}, {{5, 7}, {5, 13}}},
	'Z': {{{1, 1}, {9, 1}, {1, 13}, {9, 13}}},
}

// renderDistortedCaptchaSVG 纯标准库生成零 <text> 矢量笔画防 OCR SVG 验证码（抗正则抓取 + 贝塞尔曲线与噪点干扰）
func renderDistortedCaptchaSVG(code string) string {
	palette := []string{"#0F172A", "#1D4ED8", "#047857", "#7C2D12", "#4338CA", "#B45309"}
	var sb strings.Builder
	sb.WriteString(`<svg xmlns="http://www.w3.org/2000/svg" width="136" height="44" viewBox="0 0 136 44">`)
	sb.WriteString(`<rect width="136" height="44" rx="6" fill="#F8FAFC"/>`)

	// 背景网格线干扰
	for y := 10; y < 44; y += 11 {
		sb.WriteString(fmt.Sprintf(`<line x1="0" y1="%d" x2="136" y2="%d" stroke="#E2E8F0" stroke-width="0.8"/>`, y, y))
	}

	// 3 条随机三次贝塞尔干扰线
	for i := 0; i < 3; i++ {
		x1 := cryptoRandInt(24)
		y1 := 6 + cryptoRandInt(32)
		cx1 := 30 + cryptoRandInt(35)
		cy1 := 2 + cryptoRandInt(40)
		cx2 := 70 + cryptoRandInt(35)
		cy2 := 2 + cryptoRandInt(40)
		x2 := 112 + cryptoRandInt(24)
		y2 := 6 + cryptoRandInt(32)
		col := palette[cryptoRandInt(len(palette))]
		sb.WriteString(fmt.Sprintf(
			`<path d="M%d %d C%d %d,%d %d,%d %d" fill="none" stroke="%s" stroke-width="1.3" stroke-opacity="0.35"/>`,
			x1, y1, cx1, cy1, cx2, cy2, x2, y2, col,
		))
	}

	// 18 个随机干扰噪点
	for i := 0; i < 18; i++ {
		cx := 4 + cryptoRandInt(128)
		cy := 4 + cryptoRandInt(36)
		r := 1 + cryptoRandInt(2)
		col := palette[cryptoRandInt(len(palette))]
		sb.WriteString(fmt.Sprintf(`<circle cx="%d" cy="%d" r="%d" fill="%s" fill-opacity="0.28"/>`, cx, cy, r, col))
	}

	// 矢量路径字形渲染（每顶点带随机微扰、字符旋转与缩放，完全不含 <text> 标签）
	for i := 0; i < len(code); i++ {
		strokes := vectorGlyphs[code[i]]
		if len(strokes) == 0 {
			continue
		}
		ox := float64(14+i*30) + float64(cryptoRandInt(5)-2)
		oy := float64(9 + cryptoRandInt(7))
		scale := 1.45 + float64(cryptoRandInt(25))/100.0
		rot := cryptoRandInt(33) - 16
		cx := ox + 5.0*scale
		cy := oy + 7.0*scale
		col := palette[cryptoRandInt(len(palette))]
		sw := 2.4 + float64(cryptoRandInt(7))/10.0

		var d strings.Builder
		for _, poly := range strokes {
			for j, pt := range poly {
				jx := float64(cryptoRandInt(11)-5) / 10.0
				jy := float64(cryptoRandInt(11)-5) / 10.0
				px := ox + pt[0]*scale + jx
				py := oy + pt[1]*scale + jy
				if j == 0 {
					d.WriteString(fmt.Sprintf("M%.1f %.1f", px, py))
				} else {
					d.WriteString(fmt.Sprintf(" L%.1f %.1f", px, py))
				}
			}
		}
		sb.WriteString(fmt.Sprintf(
			`<path d="%s" fill="none" stroke="%s" stroke-width="%.1f" stroke-linecap="round" stroke-linejoin="round" transform="rotate(%d %.1f %.1f)"/>`,
			d.String(), col, sw, rot, cx, cy,
		))
	}

	// 顶部穿透细线增加自动分割难度
	ty1 := 13 + cryptoRandInt(18)
	ty2 := 13 + cryptoRandInt(18)
	sb.WriteString(fmt.Sprintf(`<line x1="6" y1="%d" x2="130" y2="%d" stroke="#64748B" stroke-width="1.1" stroke-opacity="0.4"/>`, ty1, ty2))
	sb.WriteString(`</svg>`)
	return sb.String()
}
