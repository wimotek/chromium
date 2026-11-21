import {
  SITE_TEMPLATES,
  validateDomain,
  renderTemplate,
  injectHttpsBlock,
  buildDockerCommand,
  formatBytes,
  formatCertCountdown,
  solvePowChallenge,
  validateUsername,
  evaluatePasswordStrength,
} from './helpers.js';

// ==================== STATE (Token kept strictly in memory, never localStorage) ====================
const state = {
  token: '',
  user: '',
  view: 'sites',
  sites: [],
  certs: [],
  systemInfo: null,
  siteFilter: 'all',
  siteSearch: '',
  activeSite: null, // { domain, enabled, content, savedContent, isDraft }
  mainConf: { content: '', savedContent: '', loaded: false },
  newSiteTemplateId: 'wordpress',
  pendingDeleteDomain: '',
  authMode: 'creds',
  challenge: null, // { challenge_id, salt, difficulty, expires_in }
  powPromise: null,
  powResult: null,
  powAbort: null,
  lockoutUntil: 0,
  lockoutTimer: null,
  mcpConfig: null,
  freshMcpToken: '',
};

const DNS_PROVIDER_FIELDS = {
  dns_cf: [
    { key: 'CF_Token', label: 'Cloudflare API Token', placeholder: '推荐仅授予 Zone:DNS:Edit 权限' },
    { key: 'CF_Account_ID', label: 'Account ID (可选)', placeholder: '可选填' },
  ],
  dns_ali: [
    { key: 'Ali_Key', label: 'Aliyun AccessKey ID', placeholder: 'LTAI...' },
    { key: 'Ali_Secret', label: 'Aliyun AccessKey Secret', placeholder: '输入 Secret' },
  ],
  dns_dp: [
    { key: 'DP_Id', label: 'DNSPod Token ID', placeholder: '数字 ID' },
    { key: 'DP_Key', label: 'DNSPod Token Key', placeholder: '输入 Key' },
  ],
  dns_aws: [
    { key: 'AWS_ACCESS_KEY_ID', label: 'AWS Access Key ID', placeholder: 'AKIA...' },
    { key: 'AWS_SECRET_ACCESS_KEY', label: 'AWS Secret Access Key', placeholder: '输入 Secret' },
  ],
  dns_gd: [
    { key: 'GD_Key', label: 'GoDaddy API Key', placeholder: '输入 Key' },
    { key: 'GD_Secret', label: 'GoDaddy API Secret', placeholder: '输入 Secret' },
  ],
  dns_hetzner: [
    { key: 'HETZNER_Token', label: 'Hetzner DNS API Token', placeholder: '输入 Token' },
  ],
};

// ==================== DOM HELPERS ====================
const $ = (id) => document.getElementById(id);

function showToast(message, type = 'ok') {
  const stack = $('toast-stack');
  const el = document.createElement('div');
  el.className = `toast ${type === 'err' ? 'toast-err' : 'toast-ok'}`;
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  stack.appendChild(el);
  window.setTimeout(() => {
    el.remove();
  }, 3600);
}

function setTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  $('theme-label').textContent = dark ? '浅色' : '深色';
  try {
    window.localStorage.setItem('wimotek_nginx_theme', dark ? 'dark' : 'light');
  } catch {
    // ignore storage restrictions
  }
}

function initTheme() {
  let saved = '';
  try {
    saved = window.localStorage.getItem('wimotek_nginx_theme') || '';
  } catch {
    saved = '';
  }
  setTheme(saved === 'dark');
}

function updateLineGutter(textarea, gutterEl, statusEl) {
  const val = textarea.value || '';
  const lineCount = Math.max(1, val.split('\n').length);
  const nums = [];
  for (let i = 1; i <= lineCount; i++) nums.push(String(i));
  gutterEl.textContent = nums.join('\n');
  gutterEl.scrollTop = textarea.scrollTop;
  if (statusEl) {
    const bytes = new TextEncoder().encode(val).length;
    statusEl.textContent = `${lineCount} 行 · ${formatBytes(bytes)}`;
  }
}

function bindCodeEditorBehaviors(textarea, gutterEl, statusEl, onChange, onSave) {
  textarea.addEventListener('input', () => {
    updateLineGutter(textarea, gutterEl, statusEl);
    onChange();
  });
  textarea.addEventListener('scroll', () => {
    gutterEl.scrollTop = textarea.scrollTop;
  });
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = `${textarea.value.slice(0, start)}    ${textarea.value.slice(end)}`;
      textarea.selectionStart = textarea.selectionEnd = start + 4;
      updateLineGutter(textarea, gutterEl, statusEl);
      onChange();
    }
  });
}

// ==================== API CLIENT ====================
async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  if (opts.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const resp = await fetch(path, { ...opts, headers });
  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (resp.status === 401 && path !== '/api/login') {
    logout('登录凭证已失效，请重新登录');
    throw new Error(data.error || '未授权');
  }
  if (!resp.ok) {
    const err = new Error(data.error || `请求失败 (${resp.status})`);
    err.status = resp.status;
    err.output = data.output || '';
    err.retryAfter = Number(data.retry_after) || 0;
    throw err;
  }
  return data;
}

// ==================== AUTH FLOW ====================
function switchAuthTab(mode) {
  state.authMode = mode;
  $('tab-creds').setAttribute('aria-selected', String(mode === 'creds'));
  $('tab-token').setAttribute('aria-selected', String(mode === 'token'));
  $('creds-fields').hidden = mode !== 'creds';
  $('token-fields').hidden = mode !== 'token';
  $('auth-alert').hidden = true;
}

function showAuthError(msg) {
  const el = $('auth-alert');
  el.textContent = msg;
  el.hidden = false;
}

function setPowShieldStatus(mode, text) {
  const dot = $('pow-shield-dot');
  const label = $('pow-shield-text');
  if (dot) {
    dot.className = `pow-dot ${mode ? `is-${mode}` : ''}`.trim();
  }
  if (label) {
    label.textContent = text;
  }
}

function clearLockoutCountdown() {
  if (state.lockoutTimer) {
    window.clearInterval(state.lockoutTimer);
    state.lockoutTimer = null;
  }
  state.lockoutUntil = 0;
}

function startLockoutCountdown(seconds) {
  clearLockoutCountdown();
  const secs = Math.max(1, Math.ceil(Number(seconds) || 0));
  state.lockoutUntil = Date.now() + secs * 1000;

  const tick = () => {
    const rem = Math.ceil((state.lockoutUntil - Date.now()) / 1000);
    const submitBtn = $('login-submit');
    if (rem <= 0) {
      clearLockoutCountdown();
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = '登录控制台';
      }
      fetchAuthChallenge();
      return;
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = `防刷冷却中 (${rem}s)`;
    }
    setPowShieldStatus('locked', `触发高频防刷保护，请 ${rem} 秒后重试`);
  };

  tick();
  state.lockoutTimer = window.setInterval(tick, 1000);
}

async function fetchAuthChallenge() {
  if (state.powAbort) {
    state.powAbort.abort();
  }
  const abortCtrl = new AbortController();
  state.powAbort = abortCtrl;
  state.challenge = null;
  state.powResult = null;
  state.powPromise = null;
  $('login-captcha').value = '';
  setPowShieldStatus('working', '正在获取图形验证码与动态算力挑战...');

  try {
    const res = await apiFetch('/api/auth/challenge', { method: 'GET' });
    if (abortCtrl.signal.aborted) return;
    const ch = res.data;
    state.challenge = ch;
    $('captcha-img').src = ch.captcha_image;

    if (ch.retry_after > 0) {
      startLockoutCountdown(ch.retry_after);
      return;
    }

    setPowShieldStatus('working', `正在计算防机器人工作量证明 (SHA-256 ${ch.difficulty}-bit)...`);
    state.powPromise = solvePowChallenge(ch.challenge_id, ch.salt, ch.difficulty, abortCtrl.signal)
      .then((solved) => {
        if (abortCtrl.signal.aborted) return null;
        state.powResult = solved;
        setPowShieldStatus('ready', `防机器人算力盾就绪 · ${ch.difficulty}-bit PoW (${solved.elapsedMs}ms)`);
        return solved;
      })
      .catch((err) => {
        if (!abortCtrl.signal.aborted) {
          setPowShieldStatus('locked', `算力校验初始化失败：${err.message}`);
        }
        return null;
      });
  } catch (err) {
    if (err.retryAfter > 0) {
      startLockoutCountdown(err.retryAfter);
    } else {
      setPowShieldStatus('locked', err.message || '获取验证码失败，点击图片重试');
    }
  }
}

function syncSidebarUser() {
  const el = $('sidebar-username-label');
  if (el) {
    el.textContent = `账号安全 (${state.user || 'admin'})`;
  }
}

function enterWorkspace() {
  clearLockoutCountdown();
  if (state.powAbort) {
    state.powAbort.abort();
    state.powAbort = null;
  }
  syncSidebarUser();
  $('auth-screen').hidden = true;
  $('app-shell').hidden = false;
  refreshAllData();
}

function logout(reason) {
  state.token = '';
  state.user = '';
  state.activeSite = null;
  state.mcpConfig = null;
  state.freshMcpToken = '';
  $('app-shell').hidden = true;
  $('auth-screen').hidden = false;
  if (reason) showAuthError(reason);
  fetchAuthChallenge();
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  if (Date.now() < state.lockoutUntil) return;
  $('auth-alert').hidden = true;

  const captchaAnswer = $('login-captcha').value.trim();
  if (!captchaAnswer) {
    showAuthError('请输入右侧 4 位图形验证码');
    $('login-captcha').focus();
    return;
  }
  if (!state.challenge) {
    showAuthError('安全验证尚未就绪，正在刷新...');
    fetchAuthChallenge();
    return;
  }

  const submitBtn = $('login-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = '安全校验中...';

  try {
    let solved = state.powResult;
    if (!solved && state.powPromise) {
      solved = await state.powPromise;
    }
    if (!solved) {
      solved = await solvePowChallenge(
        state.challenge.challenge_id,
        state.challenge.salt,
        state.challenge.difficulty
      );
    }

    const basePayload =
      state.authMode === 'token'
        ? { token: $('login-token').value.trim() }
        : { user: $('login-user').value.trim(), pass: $('login-pass').value };

    const payload = {
      ...basePayload,
      challenge_id: state.challenge.challenge_id,
      captcha_answer: captchaAnswer,
      pow_nonce: solved.nonce,
      hp_field: $('login-hp').value || '',
    };

    const res = await apiFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.token = res.token;
    state.user = res.user || 'admin';
    $('login-pass').value = '';
    $('login-token').value = '';
    $('login-captcha').value = '';
    enterWorkspace();
  } catch (err) {
    showAuthError(err.message || '登录失败');
    if (err.retryAfter > 0) {
      startLockoutCountdown(err.retryAfter);
    } else {
      await fetchAuthChallenge();
    }
  } finally {
    if (Date.now() >= state.lockoutUntil) {
      submitBtn.disabled = false;
      submitBtn.textContent = '登录控制台';
    }
  }
}

// ==================== ACCOUNT & SECURITY MODAL ====================
function updatePasswordStrengthUI() {
  const pwd = $('acc-new-pass').value;
  const wrap = $('acc-strength-wrap');
  if (!pwd) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const res = evaluatePasswordStrength(pwd);
  $('acc-strength-label').textContent = res.label;
  $('acc-strength-bar').setAttribute('data-score', String(res.score));
  $('acc-strength-hint').textContent = res.valid
    ? '已满足高强度密码策略（PBKDF2-HMAC-SHA256 210,000 次迭代加密保存）'
    : res.error;
}

async function openAccountModal() {
  $('account-form-error').hidden = true;
  $('acc-current-pass').value = '';
  $('acc-new-pass').value = '';
  $('acc-confirm-pass').value = '';
  $('acc-strength-wrap').hidden = true;
  $('acc-rotate-token').checked = true;
  $('acc-new-user').value = state.user || 'admin';
  openModal('modal-account');

  try {
    const res = await apiFetch('/api/account');
    const acc = res.data?.account || {};
    const shield = res.data?.shield || {};
    $('acc-meta-user').textContent = acc.username || state.user || 'admin';
    $('acc-new-user').value = acc.username || state.user || 'admin';
    $('acc-meta-source').textContent = acc.source === 'persisted' ? '已持久化 (.auth.json)' : '环境变量初始化';
    $('acc-meta-blocked').textContent = `${shield.blocked_attempts ?? 0} 次 (锁定 ${shield.locked_ips ?? 0} IP)`;
    $('acc-meta-pow').textContent = `${shield.base_pow_bits ?? 14}~${shield.max_pow_bits ?? 20} bit`;
  } catch (err) {
    $('account-form-error').textContent = err.message || '加载账户信息失败';
    $('account-form-error').hidden = false;
  }
}

async function handleAccountSubmit(e) {
  e.preventDefault();
  const errEl = $('account-form-error');
  errEl.hidden = true;

  const newUsername = $('acc-new-user').value.trim();
  const currentPassword = $('acc-current-pass').value;
  const newPassword = $('acc-new-pass').value;
  const confirmPassword = $('acc-confirm-pass').value;
  const rotateToken = $('acc-rotate-token').checked;

  const uCheck = validateUsername(newUsername);
  if (!uCheck.valid) {
    errEl.textContent = uCheck.error;
    errEl.hidden = false;
    return;
  }
  if (!currentPassword) {
    errEl.textContent = '请输入当前管理员密码进行身份核验';
    errEl.hidden = false;
    return;
  }
  if (newPassword) {
    const pCheck = evaluatePasswordStrength(newPassword);
    if (!pCheck.valid) {
      errEl.textContent = pCheck.error;
      errEl.hidden = false;
      return;
    }
    if (newPassword !== confirmPassword) {
      errEl.textContent = '两次输入的新密码不一致';
      errEl.hidden = false;
      return;
    }
  }

  const submitBtn = $('btn-account-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = '加密保存中...';

  try {
    const res = await apiFetch('/api/account/credentials', {
      method: 'POST',
      body: JSON.stringify({
        current_password: currentPassword,
        new_username: uCheck.normalized,
        new_password: newPassword,
        rotate_token: rotateToken,
      }),
    });
    if (res.token) {
      state.token = res.token;
    }
    if (res.account?.username) {
      state.user = res.account.username;
      syncSidebarUser();
    }
    closeModal('modal-account');
    showToast(res.msg || '管理员用户名与密码已安全更新');
  } catch (err) {
    errEl.textContent = err.message || '修改凭证失败';
    errEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '保存账号设置';
  }
}

// ==================== NAVIGATION & TOPBAR ====================
const VIEW_META = {
  sites: { title: '站点配置', panelId: 'view-sites' },
  certs: { title: 'SSL 证书', panelId: 'view-certs' },
  'main-conf': { title: '核心配置', panelId: 'view-main-conf' },
  build: { title: '编译与运行', panelId: 'view-build' },
  mcp: { title: 'MCP / Agent 接入', panelId: 'view-mcp' },
};

function switchView(viewId) {
  if (!VIEW_META[viewId]) return;
  state.view = viewId;

  for (const [id, info] of Object.entries(VIEW_META)) {
    const panel = $(info.panelId);
    if (panel) panel.hidden = id !== viewId;
  }

  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    if (btn.dataset.view === viewId) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.removeAttribute('aria-current');
    }
  });

  $('topbar-title').textContent = VIEW_META[viewId].title;
  closeMobileDrawer();

  if (viewId === 'main-conf' && !state.mainConf.loaded) {
    loadMainConfig();
  }
  if (viewId === 'certs') {
    loadCerts();
  }
  if (viewId === 'build') {
    loadSystemInfo();
  }
  if (viewId === 'mcp') {
    loadMcpConfig();
  }
}

function closeMobileDrawer() {
  $('sidebar').classList.remove('is-open');
  $('drawer-backdrop').classList.remove('is-open');
}

function updateTopbarSummary() {
  const total = state.sites.length;
  const enabled = state.sites.filter((s) => s.enabled).length;
  const sslCount = state.sites.filter((s) => s.has_ssl).length;
  $('topbar-meta').textContent = `${total} 个站点 · ${enabled} 个已启用 · ${sslCount} 个已配置 HTTPS`;
  $('nav-count-sites').textContent = String(total);
  $('nav-count-certs').textContent = String(state.certs.length);
}

// ==================== DATA LOADERS ====================
async function refreshAllData() {
  await Promise.all([loadSystemInfo(), loadSites(true), loadCerts(), loadMcpConfig()]);
}

async function loadSystemInfo() {
  try {
    const res = await apiFetch('/api/system/info');
    state.systemInfo = res.data;
    renderSystemInfo();
  } catch (err) {
    showToast(`获取系统信息失败：${err.message}`, 'err');
  }
}

async function loadSites(autoSelectFirst = false) {
  try {
    const res = await apiFetch('/api/sites');
    state.sites = Array.isArray(res.data) ? res.data : [];
    updateTopbarSummary();
    renderSiteList();

    if (autoSelectFirst && !state.activeSite && state.sites.length > 0) {
      await openSite(state.sites[0].domain);
    } else if (state.activeSite && !state.activeSite.isDraft) {
      const stillExists = state.sites.find((s) => s.domain === state.activeSite.domain);
      if (stillExists) {
        state.activeSite.enabled = stillExists.enabled;
        updateSiteEditorToolbar();
      }
    }
  } catch (err) {
    showToast(`加载站点列表失败：${err.message}`, 'err');
  }
}

async function loadCerts() {
  try {
    const res = await apiFetch('/api/certs');
    state.certs = Array.isArray(res.data) ? res.data : [];
    updateTopbarSummary();
    renderCertsTable();
  } catch (err) {
    showToast(`加载证书清单失败：${err.message}`, 'err');
  }
}

async function loadMainConfig() {
  try {
    const res = await apiFetch('/api/nginx-conf');
    state.mainConf.content = res.content || '';
    state.mainConf.savedContent = state.mainConf.content;
    state.mainConf.loaded = true;
    const ta = $('main-textarea');
    ta.value = state.mainConf.content;
    updateLineGutter(ta, $('main-gutter'), $('main-status-left'));
    $('main-dirty').hidden = true;
  } catch (err) {
    showToast(`读取 nginx.conf 失败：${err.message}`, 'err');
  }
}

// ==================== SITES RENDER & EDITOR ====================
function modeLabel(mode) {
  const map = { static: '静态', proxy: '反代', php: 'PHP-FPM', custom: '自定义' };
  return map[mode] || '自定义';
}

function renderSiteList() {
  const listEl = $('site-list');
  listEl.textContent = '';

  const q = state.siteSearch.trim().toLowerCase();
  const filtered = state.sites.filter((s) => {
    if (state.siteFilter === 'enabled' && !s.enabled) return false;
    if (state.siteFilter === 'disabled' && s.enabled) return false;
    if (q && !s.domain.toLowerCase().includes(q)) return false;
    return true;
  });

  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.className = 'site-empty';
    li.textContent = state.sites.length === 0 ? '暂无站点，点击右上角「新建」开始' : '无匹配的站点';
    listEl.appendChild(li);
    return;
  }

  for (const site of filtered) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `site-row${site.enabled ? '' : ' is-disabled'}`;
    if (state.activeSite && state.activeSite.domain === site.domain) {
      btn.setAttribute('aria-current', 'true');
    }

    const top = document.createElement('div');
    top.className = 'site-row-top';

    const domSpan = document.createElement('span');
    domSpan.className = 'site-domain';
    domSpan.textContent = site.domain;

    const stateSpan = document.createElement('span');
    stateSpan.className = `site-state-text ${site.enabled ? 'enabled' : 'disabled'}`;
    stateSpan.textContent = site.enabled ? '已启用' : '已停用';

    top.appendChild(domSpan);
    top.appendChild(stateSpan);

    const metaParts = [modeLabel(site.mode)];
    if (Array.isArray(site.listen_ports) && site.listen_ports.length > 0) {
      metaParts.push(site.listen_ports.join(' / '));
    }
    if (site.has_ssl) metaParts.push('HTTPS');
    if (site.gzip_static) metaParts.push('Gzip Static');
    if (site.brotli_static) metaParts.push('Brotli');

    const metaLine = document.createElement('div');
    metaLine.className = 'site-meta-line tabular';
    metaLine.textContent = metaParts.join(' · ');

    btn.appendChild(top);
    btn.appendChild(metaLine);
    btn.addEventListener('click', () => openSite(site.domain));
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

async function openSite(domain) {
  try {
    const res = await apiFetch(`/api/site?domain=${encodeURIComponent(domain)}`);
    state.activeSite = {
      domain: res.domain || domain,
      enabled: res.enabled !== false,
      content: res.content || '',
      savedContent: res.content || '',
      isDraft: false,
    };
    showActiveSiteInEditor();
    renderSiteList();
  } catch (err) {
    showToast(`读取站点配置失败：${err.message}`, 'err');
  }
}

function showActiveSiteInEditor() {
  const s = state.activeSite;
  if (!s) {
    $('site-editor-empty').hidden = false;
    $('site-editor-wrap').hidden = true;
    return;
  }
  $('site-editor-empty').hidden = true;
  $('site-editor-wrap').hidden = false;

  const ta = $('site-textarea');
  ta.value = s.content;
  updateLineGutter(ta, $('site-gutter'), $('site-status-left'));
  updateSiteEditorToolbar();
  $('site-output-bar').hidden = true;
}

function updateSiteEditorToolbar() {
  const s = state.activeSite;
  if (!s) return;
  const suffix = s.enabled ? '.conf' : '.conf.disabled';
  $('editor-filename').textContent = `/data/conf.d/${s.domain}${suffix}`;
  const isDirty = s.isDraft || s.content !== s.savedContent;
  $('editor-dirty').hidden = !isDirty;
  $('editor-dirty').textContent = s.isDraft ? '草稿未保存' : '未保存';

  const toggleBtn = $('btn-site-toggle');
  toggleBtn.textContent = s.enabled ? '停用' : '启用';
  toggleBtn.disabled = Boolean(s.isDraft);
  $('btn-site-delete').disabled = Boolean(s.isDraft);
}

function showOutputBar(prefix, ok, title, output) {
  const bar = $(`${prefix}-output-bar`);
  bar.classList.remove('is-ok', 'is-err');
  bar.classList.add(ok ? 'is-ok' : 'is-err');
  $(`${prefix}-output-title`).textContent = title;
  $(`${prefix}-output-pre`).textContent = output || (ok ? '语法校验通过。' : '执行失败。');
  bar.hidden = false;
}

async function testCurrentSite() {
  const s = state.activeSite;
  if (!s) return;
  const btn = $('btn-site-test');
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/site/test', {
      method: 'POST',
      body: JSON.stringify({ domain: s.domain, content: $('site-textarea').value }),
    });
    showOutputBar('site', true, res.msg || 'nginx -t 语法校验通过', res.output);
    showToast('语法预检通过');
  } catch (err) {
    showOutputBar('site', false, err.message, err.output);
    showToast('语法预检未通过', 'err');
  } finally {
    btn.disabled = false;
  }
}

async function saveCurrentSite() {
  const s = state.activeSite;
  if (!s) return;
  const btn = $('btn-site-save');
  btn.disabled = true;
  const content = $('site-textarea').value;
  try {
    const res = await apiFetch('/api/site', {
      method: 'POST',
      body: JSON.stringify({ domain: s.domain, content }),
    });
    s.content = content;
    s.savedContent = content;
    s.isDraft = false;
    s.enabled = true;
    updateSiteEditorToolbar();
    showOutputBar('site', true, res.msg || '配置已保存', res.output);
    showToast(`站点 ${s.domain} 已保存并校验通过`);
    await Promise.all([loadSites(false), loadSystemInfo()]);
  } catch (err) {
    showOutputBar('site', false, err.message, err.output);
    showToast('保存失败，配置已回滚', 'err');
  } finally {
    btn.disabled = false;
  }
}

async function toggleCurrentSite() {
  const s = state.activeSite;
  if (!s || s.isDraft) return;
  const nextEnabled = !s.enabled;
  try {
    const res = await apiFetch('/api/site/toggle', {
      method: 'POST',
      body: JSON.stringify({ domain: s.domain, enabled: nextEnabled }),
    });
    s.enabled = nextEnabled;
    updateSiteEditorToolbar();
    showOutputBar('site', true, res.msg || (nextEnabled ? '已启用' : '已停用'), res.output);
    showToast(res.msg || (nextEnabled ? '站点已启用' : '站点已停用'));
    await Promise.all([loadSites(false), loadSystemInfo()]);
  } catch (err) {
    showToast(err.message, 'err');
  }
}

async function confirmDeleteSite() {
  const domain = state.pendingDeleteDomain;
  if (!domain) return;
  try {
    await apiFetch(`/api/site?domain=${encodeURIComponent(domain)}`, { method: 'DELETE' });
    closeModal('modal-delete');
    showToast(`站点 ${domain} 已删除`);
    if (state.activeSite && state.activeSite.domain === domain) {
      state.activeSite = null;
      showActiveSiteInEditor();
    }
    await Promise.all([loadSites(true), loadSystemInfo()]);
  } catch (err) {
    showToast(`删除失败：${err.message}`, 'err');
  }
}

// ==================== MAIN NGINX.CONF ====================
async function saveMainConfig() {
  const btn = $('btn-main-save');
  btn.disabled = true;
  const content = $('main-textarea').value;
  try {
    const res = await apiFetch('/api/nginx-conf', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    state.mainConf.content = content;
    state.mainConf.savedContent = content;
    $('main-dirty').hidden = true;
    showOutputBar('main', true, res.msg || '主配置已保存', res.output);
    showToast('nginx.conf 已校验并保存');
  } catch (err) {
    showOutputBar('main', false, err.message, err.output);
    showToast('主配置校验失败，已自动回滚', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ==================== GLOBAL TEST & RELOAD ====================
async function runGlobalTest() {
  if (state.view === 'sites' && state.activeSite) {
    await testCurrentSite();
    return;
  }
  try {
    const res = await apiFetch('/api/reload', { method: 'POST' });
    showToast(res.msg || 'Nginx 校验并通过热重载');
  } catch (err) {
    showToast(err.message, 'err');
  }
}

async function runGlobalReload() {
  const btn = $('btn-global-reload');
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/reload', { method: 'POST' });
    showToast(res.msg || 'Nginx 已完成零停机热重载');
    if (state.view === 'sites' && state.activeSite) {
      showOutputBar('site', true, res.msg || '热重载成功', res.output);
    }
    await loadSystemInfo();
  } catch (err) {
    showToast(`热重载失败：${err.message}`, 'err');
    if (state.view === 'sites' && state.activeSite) {
      showOutputBar('site', false, err.message, err.output);
    }
  } finally {
    btn.disabled = false;
  }
}

// ==================== SSL CERTS RENDER & ACTIONS ====================
function renderCertsTable() {
  const tbody = $('certs-tbody');
  tbody.textContent = '';

  const total = state.certs.length;
  const valid = state.certs.filter((c) => c.status === 'valid').length;
  const warn = total - valid;
  $('kpi-certs-total').textContent = String(total);
  $('kpi-certs-valid').textContent = String(valid);
  $('kpi-certs-warn').textContent = String(warn);

  if (total === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.style.textAlign = 'center';
    td.style.padding = '32px 16px';
    td.style.color = 'var(--text-muted)';
    td.textContent = '暂无已部署的 TLS 证书，点击右上角「签发新证书」通过 ACME 自动签发。';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const cert of state.certs) {
    const tr = document.createElement('tr');

    const tdDomain = document.createElement('td');
    tdDomain.className = 'mono';
    tdDomain.style.fontWeight = '600';
    tdDomain.textContent = cert.domain;

    const tdIssuer = document.createElement('td');
    tdIssuer.textContent = cert.issuer || 'Unknown CA';

    const tdSans = document.createElement('td');
    tdSans.className = 'mono';
    tdSans.style.fontSize = '12px';
    tdSans.style.color = 'var(--text-secondary)';
    tdSans.textContent = Array.isArray(cert.sans) && cert.sans.length > 0 ? cert.sans.join(', ') : cert.domain;

    const tdExpiry = document.createElement('td');
    tdExpiry.className = 'mono';
    tdExpiry.textContent = cert.not_after || '--';

    const tdStatus = document.createElement('td');
    const statusClass =
      cert.status === 'expired'
        ? 'cert-status-expired'
        : cert.status === 'expiring'
        ? 'cert-status-expiring'
        : 'cert-status-valid';
    tdStatus.className = `${statusClass} tabular`;
    tdStatus.textContent = formatCertCountdown(cert.days_remaining);

    const tdAct = document.createElement('td');
    tdAct.style.textAlign = 'right';
    const injectBtn = document.createElement('button');
    injectBtn.type = 'button';
    injectBtn.className = 'btn btn-sm';
    injectBtn.textContent = '注入 HTTPS';
    injectBtn.addEventListener('click', () => injectCertIntoSite(cert.domain));
    tdAct.appendChild(injectBtn);

    tr.append(tdDomain, tdIssuer, tdSans, tdExpiry, tdStatus, tdAct);
    tbody.appendChild(tr);
  }
}

async function injectCertIntoSite(domain) {
  const siteExists = state.sites.some((s) => s.domain === domain);
  switchView('sites');
  if (siteExists) {
    await openSite(domain);
  } else {
    state.activeSite = {
      domain,
      enabled: true,
      content: renderTemplate('static_spa', domain),
      savedContent: '',
      isDraft: true,
    };
    showActiveSiteInEditor();
  }

  const ta = $('site-textarea');
  const res = injectHttpsBlock(ta.value, domain);
  if (res.error) {
    showToast(res.error, 'err');
    return;
  }
  if (res.alreadyConfigured) {
    showToast(`${domain} 已包含 HTTPS 配置，无需重复注入`);
    return;
  }
  ta.value = res.content;
  state.activeSite.content = res.content;
  updateLineGutter(ta, $('site-gutter'), $('site-status-left'));
  updateSiteEditorToolbar();
  showToast(`已将 TLS 1.2/1.3 与 HTTP/2 注入 ${domain} 的 server {} 块内，请核对后保存`);
}

// ==================== BUILD & CUSTOMIZER VIEW ====================
function formatUptime(sec) {
  const s = Number(sec) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `持续守护 ${h}h ${m}m`;
  return `持续守护 ${m}m ${s % 60}s`;
}

function renderSystemInfo() {
  const data = state.systemInfo;
  if (!data || !data.nginx) return;
  const ng = data.nginx;
  const sum = data.summary || {};

  $('sidebar-version').textContent = `nginx / ${ng.version || '--'}`;
  $('engine-state-text').textContent = ng.running ? 'Nginx 运行中' : 'Nginx 已停止';
  $('engine-dot').classList.toggle('stopped', !ng.running);
  $('engine-pid').textContent = ng.pid ? `PID ${ng.pid}` : 'PID --';

  $('build-version').textContent = ng.version || '--';
  const compilerEl = $('build-compiler');
  compilerEl.textContent = ng.compiler || 'Alpine 源码编译';
  compilerEl.title = ng.compiler || '';
  $('build-pid').textContent = ng.running ? `PID ${ng.pid}` : 'Stopped';
  $('build-uptime').textContent = formatUptime(ng.uptime_seconds);

  const mods = Array.isArray(ng.modules) ? ng.modules : [];
  const enabledMods = mods.filter((m) => m.enabled).length;
  $('build-mod-count').textContent = `${enabledMods} / ${mods.length}`;
  $('build-site-summary').textContent = `${sum.ssl_sites ?? 0} / ${sum.total_sites ?? 0} HTTPS`;

  const grid = $('modules-grid');
  grid.textContent = '';
  for (const mod of mods) {
    const cell = document.createElement('div');
    cell.className = 'module-cell';

    const head = document.createElement('div');
    head.className = 'module-head';

    const name = document.createElement('span');
    name.className = 'module-name';
    name.textContent = mod.name;

    const flag = document.createElement('span');
    flag.className = `module-flag ${mod.enabled ? 'on' : 'off'}`;
    flag.textContent = mod.enabled ? '已内置' : '未启用';

    head.append(name, flag);

    const cat = document.createElement('div');
    cat.className = 'module-cat';
    cat.textContent = mod.category || '';

    const desc = document.createElement('div');
    desc.className = 'module-desc';
    desc.textContent = mod.description || '';

    cell.append(head, cat, desc);
    grid.appendChild(cell);
  }

  $('raw-nginx-v').textContent = ng.raw_output || '暂无 nginx -V 输出';
}

function updateCustomDockerCommand() {
  const checkedExtras = Array.from(document.querySelectorAll('.cb-extra-flag:checked')).map((el) => el.value);
  const rawExtra = $('cb-extra-raw').value.trim();
  const extraParts = [...checkedExtras];
  if (rawExtra) extraParts.push(rawExtra);

  const cmd = buildDockerCommand({
    nginxVersion: $('cb-version').value,
    imageTag: $('cb-tag').value,
    extraCflags: $('cb-cflags').value,
    enableGzipStatic: $('cb-gzip-static').checked,
    enableBrotli: $('cb-brotli').checked,
    enableHeadersMore: $('cb-headers-more').checked,
    enableZstd: $('cb-zstd').checked,
    extraConfigureArgs: extraParts,
  });
  $('cb-output').textContent = cmd;
}

// ==================== MCP & AGENT MANAGEMENT ====================
async function loadMcpConfig() {
  try {
    const res = await apiFetch('/api/mcp/config');
    state.mcpConfig = res.data || null;
    renderMcpConfig();
  } catch (err) {
    if (state.view === 'mcp') {
      showToast(`加载 MCP 配置失败：${err.message}`, 'err');
    }
  }
}

function buildMcpClientConfigJson() {
  const endpoint = `${window.location.origin}/mcp`;
  const tokenPlaceholder = state.freshMcpToken || '<YOUR_MCP_TOKEN>';
  return JSON.stringify(
    {
      mcpServers: {
        'wimotek-nginx': {
          type: 'streamable-http',
          url: endpoint,
          headers: {
            Authorization: `Bearer ${tokenPlaceholder}`,
          },
        },
      },
    },
    null,
    2
  );
}

function renderMcpConfig() {
  const cfg = state.mcpConfig;
  if (!cfg) return;

  const navBadge = $('nav-mcp-state');
  if (navBadge) {
    navBadge.textContent = cfg.enabled ? '开启' : '关闭';
    navBadge.classList.toggle('is-on', Boolean(cfg.enabled));
  }

  $('mcp-kpi-status').textContent = cfg.enabled ? '已开启' : '已关闭';
  $('mcp-kpi-mode').textContent = cfg.read_only ? '只读巡检' : '读写管理';
  $('mcp-kpi-tools').textContent = `${cfg.active_tool_count ?? 0} / ${cfg.total_tool_count ?? 13} 个工具已开放`;
  $('mcp-kpi-token-mode').textContent = cfg.has_dedicated_token ? '独立 Token' : '复用会话 Token';
  $('mcp-kpi-token-preview').textContent = cfg.has_dedicated_token
    ? cfg.token_preview || '••••••••'
    : '跟随当前 AUTH_TOKEN';
  $('mcp-kpi-source').textContent = cfg.source === 'persisted' ? '已持久化' : '环境变量默认';

  $('mcp-toggle-enabled').checked = Boolean(cfg.enabled);
  $('mcp-toggle-readonly').checked = Boolean(cfg.read_only);
  $('btn-mcp-clear-token').disabled = !cfg.has_dedicated_token;

  $('mcp-token-desc').textContent = cfg.has_dedicated_token
    ? `当前已启用独立 MCP Token (${cfg.token_preview})，与后台管理员会话完全隔离。`
    : '当前复用后台会话 AUTH_TOKEN；推荐点击右侧按钮生成高强度独立 MCP Token。';

  if (state.freshMcpToken) {
    $('mcp-fresh-token-val').textContent = state.freshMcpToken;
    $('mcp-fresh-token-box').hidden = false;
  } else {
    $('mcp-fresh-token-box').hidden = true;
  }

  $('mcp-client-json').textContent = buildMcpClientConfigJson();

  const grid = $('mcp-tools-grid');
  grid.textContent = '';
  const tools = Array.isArray(cfg.tools) ? cfg.tools : [];
  for (const t of tools) {
    const cell = document.createElement('div');
    cell.className = 'module-cell';

    const head = document.createElement('div');
    head.className = 'module-head';

    const name = document.createElement('span');
    name.className = 'module-name';
    name.textContent = t.name;

    const flag = document.createElement('span');
    if (!cfg.enabled) {
      flag.className = 'module-flag off';
      flag.textContent = '服务未开启';
    } else if (t.allowed) {
      flag.className = 'module-flag on';
      flag.textContent = '已开放';
    } else {
      flag.className = 'module-flag warn';
      flag.textContent = '只读拦截';
    }

    head.append(name, flag);

    const cat = document.createElement('div');
    cat.className = 'module-cat';
    cat.textContent = t.mutating ? '变更工具 · 原子校验回滚' : '只读 / 干跑工具';

    const desc = document.createElement('div');
    desc.className = 'module-desc';
    desc.textContent = t.description || '';

    cell.append(head, cat, desc);
    grid.appendChild(cell);
  }
}

async function saveMcpSettings(extraPayload = {}, successMsg = '') {
  const payload = {
    enabled: $('mcp-toggle-enabled').checked,
    read_only: $('mcp-toggle-readonly').checked,
    ...extraPayload,
  };
  try {
    const res = await apiFetch('/api/mcp/config', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.mcpConfig = res.data || state.mcpConfig;
    if (res.plain_token) {
      state.freshMcpToken = res.plain_token;
    } else if (extraPayload.clear_token) {
      state.freshMcpToken = '';
    }
    renderMcpConfig();
    showToast(successMsg || res.msg || 'MCP 配置已保存并立即生效');
  } catch (err) {
    showToast(`更新 MCP 配置失败：${err.message}`, 'err');
    await loadMcpConfig();
  }
}

// ==================== MODALS ====================
function openModal(id) {
  $(id).hidden = false;
}

function closeModal(id) {
  $(id).hidden = true;
}

function renderNewSiteTemplates() {
  const grid = $('new-site-templates');
  grid.textContent = '';
  for (const tpl of SITE_TEMPLATES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'template-option';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(tpl.id === state.newSiteTemplateId));

    const title = document.createElement('div');
    title.className = 'template-option-title';
    title.textContent = tpl.shortName;

    const desc = document.createElement('div');
    desc.className = 'template-option-desc';
    desc.textContent = tpl.description;

    btn.append(title, desc);
    btn.addEventListener('click', () => {
      state.newSiteTemplateId = tpl.id;
      renderNewSiteTemplates();
      $('new-site-upstream-wrap').hidden = tpl.id !== 'proxy';
    });
    grid.appendChild(btn);
  }
}

function openNewSiteModal() {
  $('new-site-domain').value = '';
  $('new-site-error').hidden = true;
  state.newSiteTemplateId = 'wordpress';
  renderNewSiteTemplates();
  $('new-site-upstream-wrap').hidden = true;
  openModal('modal-new-site');
  $('new-site-domain').focus();
}

function handleNewSiteSubmit(e) {
  e.preventDefault();
  const check = validateDomain($('new-site-domain').value);
  if (!check.valid) {
    $('new-site-error').textContent = check.error;
    $('new-site-error').hidden = false;
    return;
  }
  const upstream = $('new-site-upstream').value.trim() || 'http://127.0.0.1:8080';
  const content = renderTemplate(state.newSiteTemplateId, check.normalized, { upstream });

  state.activeSite = {
    domain: check.normalized,
    enabled: true,
    content,
    savedContent: '',
    isDraft: true,
  };
  closeModal('modal-new-site');
  switchView('sites');
  showActiveSiteInEditor();
  renderSiteList();
  showToast(`已生成 ${check.normalized} 模板草稿，确认后点击「保存配置」生效`);
}

function renderDnsProviderFields() {
  const provider = $('ssl-provider').value;
  const wrap = $('ssl-provider-fields');
  wrap.textContent = '';
  const fields = DNS_PROVIDER_FIELDS[provider] || [];
  for (const f of fields) {
    const div = document.createElement('div');
    div.className = 'field';
    const label = document.createElement('label');
    label.setAttribute('for', `dns-env-${f.key}`);
    label.textContent = `${f.label} (${f.key})`;
    const input = document.createElement('input');
    input.id = `dns-env-${f.key}`;
    input.type = 'password';
    input.className = 'input mono';
    input.dataset.envKey = f.key;
    input.placeholder = f.placeholder || '';
    input.autocomplete = 'off';
    div.append(label, input);
    wrap.appendChild(div);
  }
}

function openSslModal(prefillDomain = '') {
  $('ssl-form-error').hidden = true;
  $('ssl-domain').value = prefillDomain;
  $('ssl-type').value = 'http';
  $('ssl-ca').value = 'letsencrypt';
  $('ssl-wildcard').checked = false;
  $('ssl-dns-section').hidden = true;
  renderDnsProviderFields();
  openModal('modal-ssl');
  $('ssl-domain').focus();
}

async function handleSslSubmit(e) {
  e.preventDefault();
  $('ssl-form-error').hidden = true;
  const check = validateDomain($('ssl-domain').value);
  if (!check.valid) {
    $('ssl-form-error').textContent = check.error;
    $('ssl-form-error').hidden = false;
    return;
  }

  const type = $('ssl-type').value;
  const envParams = {};
  if (type === 'dns') {
    document.querySelectorAll('#ssl-provider-fields input[data-env-key]').forEach((input) => {
      const val = input.value.trim();
      if (val) envParams[input.dataset.envKey] = val;
    });
  }

  const btn = $('btn-ssl-submit');
  btn.disabled = true;
  btn.textContent = '签发中...';

  try {
    const res = await apiFetch('/api/ssl/issue', {
      method: 'POST',
      body: JSON.stringify({
        domain: check.normalized,
        type,
        ca_server: $('ssl-ca').value,
        provider: type === 'dns' ? $('ssl-provider').value : '',
        is_wildcard: type === 'dns' && $('ssl-wildcard').checked,
        env_params: envParams,
      }),
    });
    closeModal('modal-ssl');
    showToast(res.msg || `证书 ${check.normalized} 签发成功`);
    await Promise.all([loadCerts(), loadSystemInfo()]);
  } catch (err) {
    $('ssl-form-error').textContent = err.message;
    $('ssl-form-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '立即签发证书';
  }
}

// ==================== WIRE EVENTS ====================
function initEvents() {
  // Theme & Auth
  $('tab-creds').addEventListener('click', () => switchAuthTab('creds'));
  $('tab-token').addEventListener('click', () => switchAuthTab('token'));
  $('login-form').addEventListener('submit', handleLoginSubmit);
  $('btn-theme-toggle').addEventListener('click', () => {
    setTheme(!document.documentElement.classList.contains('dark'));
  });
  $('btn-logout').addEventListener('click', () => logout(''));

  // Mobile drawer
  $('btn-mobile-menu').addEventListener('click', () => {
    $('sidebar').classList.add('is-open');
    $('drawer-backdrop').classList.add('is-open');
  });
  $('drawer-backdrop').addEventListener('click', closeMobileDrawer);

  // Navigation
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Topbar actions
  $('btn-global-test').addEventListener('click', runGlobalTest);
  $('btn-global-reload').addEventListener('click', runGlobalReload);

  // Sites rail
  $('site-search').addEventListener('input', (e) => {
    state.siteSearch = e.target.value;
    renderSiteList();
  });
  document.querySelectorAll('.segmented-btn[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.siteFilter = btn.dataset.filter;
      document.querySelectorAll('.segmented-btn[data-filter]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.filter === state.siteFilter));
      });
      renderSiteList();
    });
  });

  $('btn-open-new-site').addEventListener('click', openNewSiteModal);
  $('btn-empty-new-site').addEventListener('click', openNewSiteModal);

  // Site editor toolbar & textarea
  bindCodeEditorBehaviors(
    $('site-textarea'),
    $('site-gutter'),
    $('site-status-left'),
    () => {
      if (state.activeSite) {
        state.activeSite.content = $('site-textarea').value;
        updateSiteEditorToolbar();
      }
    },
    saveCurrentSite
  );

  $('template-apply-select').addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id || !state.activeSite) return;
    const rendered = renderTemplate(id, state.activeSite.domain);
    $('site-textarea').value = rendered;
    state.activeSite.content = rendered;
    updateLineGutter($('site-textarea'), $('site-gutter'), $('site-status-left'));
    updateSiteEditorToolbar();
    e.target.value = '';
    showToast('已替换编辑器内容为所选模板，请核对后保存');
  });

  $('btn-site-toggle').addEventListener('click', toggleCurrentSite);
  $('btn-site-ssl').addEventListener('click', () => openSslModal(state.activeSite?.domain || ''));
  $('btn-site-test').addEventListener('click', testCurrentSite);
  $('btn-site-save').addEventListener('click', saveCurrentSite);
  $('btn-site-delete').addEventListener('click', () => {
    if (!state.activeSite || state.activeSite.isDraft) return;
    state.pendingDeleteDomain = state.activeSite.domain;
    $('delete-target-domain').textContent = state.activeSite.domain;
    openModal('modal-delete');
  });
  $('btn-confirm-delete').addEventListener('click', confirmDeleteSite);
  $('btn-close-site-output').addEventListener('click', () => {
    $('site-output-bar').hidden = true;
  });

  // Main nginx.conf editor
  bindCodeEditorBehaviors(
    $('main-textarea'),
    $('main-gutter'),
    $('main-status-left'),
    () => {
      state.mainConf.content = $('main-textarea').value;
      $('main-dirty').hidden = state.mainConf.content === state.mainConf.savedContent;
    },
    saveMainConfig
  );
  $('btn-main-reload-read').addEventListener('click', loadMainConfig);
  $('btn-main-save').addEventListener('click', saveMainConfig);
  $('btn-close-main-output').addEventListener('click', () => {
    $('main-output-bar').hidden = true;
  });

  // Certs view
  $('btn-refresh-certs').addEventListener('click', loadCerts);
  $('btn-open-issue-ssl').addEventListener('click', () => openSslModal(''));

  // Build customizer
  ['cb-version', 'cb-tag', 'cb-cflags', 'cb-extra-raw'].forEach((id) => {
    $(id).addEventListener('input', updateCustomDockerCommand);
  });
  ['cb-gzip-static', 'cb-brotli', 'cb-headers-more', 'cb-zstd'].forEach((id) => {
    $(id).addEventListener('change', updateCustomDockerCommand);
  });
  document.querySelectorAll('.cb-extra-flag').forEach((el) => {
    el.addEventListener('change', updateCustomDockerCommand);
  });
  $('btn-copy-docker-cmd').addEventListener('click', async () => {
    const cmd = $('cb-output').textContent;
    try {
      await navigator.clipboard.writeText(cmd);
      showToast('已复制自定义 Docker 构建命令');
    } catch {
      showToast('已选中构建命令，请手动复制', 'ok');
    }
  });

  // MCP / Agent management view
  $('btn-mcp-refresh').addEventListener('click', loadMcpConfig);
  $('mcp-toggle-enabled').addEventListener('change', () => {
    const on = $('mcp-toggle-enabled').checked;
    saveMcpSettings({}, on ? 'MCP 服务已立即开启 (/mcp)' : 'MCP 服务已关闭');
  });
  $('mcp-toggle-readonly').addEventListener('change', () => {
    const ro = $('mcp-toggle-readonly').checked;
    saveMcpSettings({}, ro ? '已切换为 MCP 只读安全模式' : '已切换为 MCP 读写管理模式');
  });
  $('btn-mcp-rotate-token').addEventListener('click', () => {
    saveMcpSettings({ rotate_token: true }, '已生成新的独立 MCP Token 并立即生效');
  });
  $('btn-mcp-clear-token').addEventListener('click', () => {
    saveMcpSettings({ clear_token: true }, '已清除独立 Token，当前回退复用后台 AUTH_TOKEN');
  });
  $('btn-mcp-copy-token').addEventListener('click', async () => {
    if (!state.freshMcpToken) return;
    try {
      await navigator.clipboard.writeText(state.freshMcpToken);
      showToast('已复制独立 MCP Token');
    } catch {
      showToast('请手动复制展示框中的 MCP Token', 'ok');
    }
  });
  $('btn-mcp-copy-json').addEventListener('click', async () => {
    const jsonText = $('mcp-client-json').textContent;
    try {
      await navigator.clipboard.writeText(jsonText);
      showToast('已复制 MCP 客户端接入 JSON');
    } catch {
      showToast('请手动复制客户端接入 JSON', 'ok');
    }
  });

  // Modals close
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.hidden = true;
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop').forEach((m) => {
        m.hidden = true;
      });
      closeMobileDrawer();
    }
  });

  // Modal forms
  $('btn-refresh-captcha').addEventListener('click', fetchAuthChallenge);
  $('btn-account-modal').addEventListener('click', openAccountModal);
  $('acc-new-pass').addEventListener('input', updatePasswordStrengthUI);
  $('account-form').addEventListener('submit', handleAccountSubmit);
  $('new-site-form').addEventListener('submit', handleNewSiteSubmit);
  $('ssl-type').addEventListener('change', () => {
    $('ssl-dns-section').hidden = $('ssl-type').value !== 'dns';
  });
  $('ssl-provider').addEventListener('change', renderDnsProviderFields);
  $('ssl-form').addEventListener('submit', handleSslSubmit);
}

// ==================== BOOT ====================
initTheme();
initEvents();
updateCustomDockerCommand();
fetchAuthChallenge();