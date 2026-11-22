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
import {
  t,
  tPlural,
  hasKey,
  getLocale,
  setLocale,
  onLocaleChange,
  initI18n,
  localizeApiError,
} from './i18n/index.js';

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
  powStatus: { mode: '', key: 'auth.powInit', params: {} },
  lockoutUntil: 0,
  lockoutTimer: null,
  mcpConfig: null,
  freshMcpToken: '',
  accountMeta: null,
};

const DNS_PROVIDER_KEYS = {
  dns_cf: ['CF_Token', 'CF_Account_ID'],
  dns_ali: ['Ali_Key', 'Ali_Secret'],
  dns_dp: ['DP_Id', 'DP_Key'],
  dns_aws: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  dns_gd: ['GD_Key', 'GD_Secret'],
  dns_hetzner: ['HETZNER_Token'],
};

const STRENGTH_LEVEL_KEY = {
  empty: 'modals.account.strengthLevelEmpty',
  weak: 'modals.account.strengthLevelWeak',
  medium: 'modals.account.strengthLevelMedium',
  strong: 'modals.account.strengthLevelStrong',
  very_strong: 'modals.account.strengthLevelVeryStrong',
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
  $('theme-label').textContent = dark ? t('common.themeLight') : t('common.themeDark');
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

function syncLangButtons() {
  const active = getLocale();
  document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.langBtn === active));
  });
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
    statusEl.textContent = t('common.linesBytes', { lines: lineCount, bytes: formatBytes(bytes) });
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
    logout(t('auth.errSessionExpired'));
    const err = new Error(localizeApiError({ ...data, status: resp.status }));
    err.status = resp.status;
    err.errorCode = data.error_code || 'ERR_UNAUTHORIZED';
    throw err;
  }
  if (!resp.ok) {
    const err = new Error(localizeApiError({ ...data, status: resp.status }));
    err.status = resp.status;
    err.errorCode = data.error_code || '';
    err.errorParams = data.error_params || {};
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

function setPowShieldStatus(mode, keyOrRaw, params = {}) {
  state.powStatus = { mode, key: keyOrRaw, params };
  const dot = $('pow-shield-dot');
  const label = $('pow-shield-text');
  if (dot) {
    dot.className = `pow-dot ${mode ? `is-${mode}` : ''}`.trim();
  }
  if (label) {
    label.textContent = hasKey(keyOrRaw) ? t(keyOrRaw, params) : String(keyOrRaw || '');
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
        submitBtn.textContent = t('auth.submitBtn');
      }
      fetchAuthChallenge();
      return;
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = t('auth.cooldownBtn', { sec: rem });
    }
    setPowShieldStatus('locked', 'auth.powLocked', { sec: rem });
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
  setPowShieldStatus('working', 'auth.powFetching');

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

    setPowShieldStatus('working', 'auth.powComputing', { difficulty: ch.difficulty });
    state.powPromise = solvePowChallenge(ch.challenge_id, ch.salt, ch.difficulty, abortCtrl.signal)
      .then((solved) => {
        if (abortCtrl.signal.aborted) return null;
        state.powResult = solved;
        setPowShieldStatus('ready', 'auth.powReady', {
          difficulty: ch.difficulty,
          ms: solved.elapsedMs,
        });
        return solved;
      })
      .catch((err) => {
        if (!abortCtrl.signal.aborted) {
          setPowShieldStatus('locked', 'auth.powFailed', { msg: err.message });
        }
        return null;
      });
  } catch (err) {
    if (err.retryAfter > 0) {
      startLockoutCountdown(err.retryAfter);
    } else {
      setPowShieldStatus('locked', err.message || t('auth.powFetchFailed'));
    }
  }
}

function syncSidebarUser() {
  const el = $('sidebar-username-label');
  if (el) {
    el.textContent = t('nav.accountBtn', { user: state.user || 'admin' });
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
    showAuthError(t('auth.errCaptchaEmpty'));
    $('login-captcha').focus();
    return;
  }
  if (!state.challenge) {
    showAuthError(t('auth.errChallengeNotReady'));
    fetchAuthChallenge();
    return;
  }

  const submitBtn = $('login-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = t('auth.submittingBtn');

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
    showAuthError(err.message || t('auth.errLoginFailed'));
    if (err.retryAfter > 0) {
      startLockoutCountdown(err.retryAfter);
    } else {
      await fetchAuthChallenge();
    }
  } finally {
    if (Date.now() >= state.lockoutUntil) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('auth.submitBtn');
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
  $('acc-strength-label').textContent = t(STRENGTH_LEVEL_KEY[res.level] || 'modals.account.strengthLevelWeak');
  $('acc-strength-bar').setAttribute('data-score', String(res.score));
  $('acc-strength-hint').textContent = res.valid
    ? t('modals.account.strengthValidHint')
    : localizeApiError(res);
}

function renderAccountMeta() {
  if (!state.accountMeta) return;
  const { account: acc = {}, shield = {} } = state.accountMeta;
  $('acc-meta-user').textContent = acc.username || state.user || 'admin';
  $('acc-meta-source').textContent =
    acc.source === 'persisted'
      ? t('modals.account.metaSourcePersisted')
      : t('modals.account.metaSourceEnv');
  const blockedCount = Number(shield.blocked_attempts ?? 0);
  $('acc-meta-blocked').textContent = tPlural('modals.account.metaBlockedVal', blockedCount, {
    count: blockedCount,
    ips: shield.locked_ips ?? 0,
  });
  $('acc-meta-pow').textContent = `${shield.base_pow_bits ?? 14}~${shield.max_pow_bits ?? 20} bit`;
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
    state.accountMeta = res.data || {};
    const acc = state.accountMeta.account || {};
    $('acc-new-user').value = acc.username || state.user || 'admin';
    renderAccountMeta();
  } catch (err) {
    $('account-form-error').textContent = err.message || t('modals.account.errLoadFailed');
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
    errEl.textContent = localizeApiError(uCheck);
    errEl.hidden = false;
    return;
  }
  if (!currentPassword) {
    errEl.textContent = t('modals.account.errCurrentPassRequired');
    errEl.hidden = false;
    return;
  }
  if (newPassword) {
    const pCheck = evaluatePasswordStrength(newPassword);
    if (!pCheck.valid) {
      errEl.textContent = localizeApiError(pCheck);
      errEl.hidden = false;
      return;
    }
    if (newPassword !== confirmPassword) {
      errEl.textContent = t('modals.account.errConfirmMismatch');
      errEl.hidden = false;
      return;
    }
  }

  const submitBtn = $('btn-account-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = t('modals.account.submittingBtn');

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
    showToast(t('modals.account.toastUpdated'));
  } catch (err) {
    errEl.textContent = err.message || t('modals.account.errUpdateFailed');
    errEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = t('modals.account.submitBtn');
  }
}

// ==================== NAVIGATION & TOPBAR ====================
const VIEW_META = {
  sites: { titleKey: 'nav.sites', panelId: 'view-sites' },
  certs: { titleKey: 'nav.certs', panelId: 'view-certs' },
  'main-conf': { titleKey: 'nav.mainConf', panelId: 'view-main-conf' },
  build: { titleKey: 'nav.build', panelId: 'view-build' },
  mcp: { titleKey: 'nav.mcpViewTitle', panelId: 'view-mcp' },
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

  $('topbar-title').textContent = t(VIEW_META[viewId].titleKey);
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
  $('topbar-meta').textContent = t('topbar.summary', {
    total,
    enabled,
    ssl: sslCount,
  });
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
    showToast(t('build.toastSysInfoFailed', { msg: err.message }), 'err');
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
    showToast(t('sites.toastLoadFailed', { msg: err.message }), 'err');
  }
}

async function loadCerts() {
  try {
    const res = await apiFetch('/api/certs');
    state.certs = Array.isArray(res.data) ? res.data : [];
    updateTopbarSummary();
    renderCertsTable();
  } catch (err) {
    showToast(t('certs.toastLoadFailed', { msg: err.message }), 'err');
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
    showToast(t('mainConf.toastLoadFailed', { msg: err.message }), 'err');
  }
}

// ==================== SITES RENDER & EDITOR ====================
function modeLabel(mode) {
  const map = {
    static: 'sites.modeStatic',
    proxy: 'sites.modeProxy',
    php: 'sites.modePhp',
    custom: 'sites.modeCustom',
  };
  return t(map[mode] || 'sites.modeCustom');
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
    li.textContent = state.sites.length === 0 ? t('sites.emptyNoSites') : t('sites.emptyNoMatch');
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
    stateSpan.textContent = site.enabled ? t('common.enabled') : t('common.disabled');

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
    showToast(t('sites.toastOpenFailed', { msg: err.message }), 'err');
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
  $('editor-dirty').textContent = s.isDraft ? t('sites.dirtyDraft') : t('sites.dirtyUnsaved');

  const toggleBtn = $('btn-site-toggle');
  toggleBtn.textContent = s.enabled ? t('sites.btnDisable') : t('sites.btnEnable');
  toggleBtn.disabled = Boolean(s.isDraft);
  $('btn-site-delete').disabled = Boolean(s.isDraft);
}

function showOutputBar(prefix, ok, title, output) {
  const bar = $(`${prefix}-output-bar`);
  bar.classList.remove('is-ok', 'is-err');
  bar.classList.add(ok ? 'is-ok' : 'is-err');
  $(`${prefix}-output-title`).textContent = title;
  $(`${prefix}-output-pre`).textContent = output || (ok ? t('common.testPassedDefault') : t('common.actionFailedDefault'));
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
    showOutputBar('site', true, t('sites.outputTestOk'), res.output);
    showToast(t('sites.toastTestPassed'));
  } catch (err) {
    showOutputBar('site', false, err.message, err.output);
    showToast(t('sites.toastTestFailed'), 'err');
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
    showOutputBar('site', true, t('sites.outputSaveOk'), res.output);
    showToast(t('sites.toastSavePassed', { domain: s.domain }));
    await Promise.all([loadSites(false), loadSystemInfo()]);
  } catch (err) {
    showOutputBar('site', false, err.message, err.output);
    showToast(t('sites.toastSaveFailed'), 'err');
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
    const label = nextEnabled
      ? t('sites.toastEnabled', { domain: s.domain })
      : t('sites.toastDisabled', { domain: s.domain });
    showOutputBar('site', true, label, res.output);
    showToast(label);
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
    showToast(t('sites.toastDeleted', { domain }));
    if (state.activeSite && state.activeSite.domain === domain) {
      state.activeSite = null;
      showActiveSiteInEditor();
    }
    await Promise.all([loadSites(true), loadSystemInfo()]);
  } catch (err) {
    showToast(t('sites.toastDeleteFailed', { msg: err.message }), 'err');
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
    showOutputBar('main', true, t('mainConf.outputSaveOk'), res.output);
    showToast(t('mainConf.toastSaveOk'));
  } catch (err) {
    showOutputBar('main', false, err.message, err.output);
    showToast(t('mainConf.toastSaveFailed'), 'err');
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
    await apiFetch('/api/reload', { method: 'POST' });
    showToast(t('sites.toastReloadOk'));
  } catch (err) {
    showToast(err.message, 'err');
  }
}

async function runGlobalReload() {
  const btn = $('btn-global-reload');
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/reload', { method: 'POST' });
    showToast(t('sites.toastReloadOk'));
    if (state.view === 'sites' && state.activeSite) {
      showOutputBar('site', true, t('sites.outputReloadOk'), res.output);
    }
    await loadSystemInfo();
  } catch (err) {
    showToast(t('sites.toastReloadFailed', { msg: err.message }), 'err');
    if (state.view === 'sites' && state.activeSite) {
      showOutputBar('site', false, err.message, err.output);
    }
  } finally {
    btn.disabled = false;
  }
}

// ==================== SSL CERTS RENDER & ACTIONS ====================
function formatLocalizedCertCountdown(days) {
  return formatCertCountdown(days, {
    unknown: () => t('certs.countdownUnknown'),
    today: () => t('certs.countdownToday'),
    remaining: (d) => tPlural('certs.countdownRemaining', d, { days: d }),
    expired: (d) => tPlural('certs.countdownExpired', d, { days: d }),
  });
}

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
    td.textContent = t('certs.emptyRow');
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
    tdIssuer.textContent = cert.issuer || t('certs.unknownCa');

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
    tdStatus.textContent = formatLocalizedCertCountdown(cert.days_remaining);

    const tdAct = document.createElement('td');
    tdAct.style.textAlign = 'right';
    const injectBtn = document.createElement('button');
    injectBtn.type = 'button';
    injectBtn.className = 'btn btn-sm';
    injectBtn.textContent = t('certs.btnInjectHttps');
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
    showToast(localizeApiError(res), 'err');
    return;
  }
  if (res.alreadyConfigured) {
    showToast(t('certs.toastAlreadyHttps', { domain }));
    return;
  }
  ta.value = res.content;
  state.activeSite.content = res.content;
  updateLineGutter(ta, $('site-gutter'), $('site-status-left'));
  updateSiteEditorToolbar();
  showToast(t('certs.toastInjected', { domain }));
}

// ==================== BUILD & CUSTOMIZER VIEW ====================
function formatUptime(sec) {
  const s = Number(sec) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return t('build.uptimeHm', { h, m });
  return t('build.uptimeMs', { m, s: s % 60 });
}

function renderSystemInfo() {
  const data = state.systemInfo;
  if (!data || !data.nginx) return;
  const ng = data.nginx;
  const sum = data.summary || {};

  $('sidebar-version').textContent = `nginx / ${ng.version || '--'}`;
  $('engine-state-text').textContent = ng.running ? t('nav.engineRunning') : t('nav.engineStopped');
  $('engine-dot').classList.toggle('stopped', !ng.running);
  $('engine-pid').textContent = ng.pid ? `PID ${ng.pid}` : 'PID --';

  $('build-version').textContent = ng.version || '--';
  const compilerEl = $('build-compiler');
  compilerEl.textContent = ng.compiler || t('build.kpiVersionSubFallback');
  compilerEl.title = ng.compiler || '';
  $('build-pid').textContent = ng.running ? `PID ${ng.pid}` : t('build.stopped');
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
    flag.textContent = mod.enabled ? t('build.flagBuiltin') : t('build.flagDisabled');

    head.append(name, flag);

    const catKey = `build.modules.${mod.name}.cat`;
    const descKey = `build.modules.${mod.name}.desc`;

    const cat = document.createElement('div');
    cat.className = 'module-cat';
    cat.textContent = hasKey(catKey) ? t(catKey) : (mod.category || '');

    const desc = document.createElement('div');
    desc.className = 'module-desc';
    desc.textContent = hasKey(descKey) ? t(descKey) : (mod.description || '');

    cell.append(head, cat, desc);
    grid.appendChild(cell);
  }

  $('raw-nginx-v').textContent = ng.raw_output || t('build.rawEmpty');
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
      showToast(t('mcp.toastLoadFailed', { msg: err.message }), 'err');
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
    navBadge.textContent = cfg.enabled ? t('common.on') : t('common.off');
    navBadge.classList.toggle('is-on', Boolean(cfg.enabled));
  }

  $('mcp-kpi-status').textContent = cfg.enabled ? t('common.active') : t('common.inactive');
  $('mcp-kpi-mode').textContent = cfg.read_only ? t('mcp.kpiModeReadOnly') : t('mcp.kpiModeReadWrite');
  $('mcp-kpi-tools').textContent = t('mcp.kpiToolsOpen', {
    active: cfg.active_tool_count ?? 0,
    total: cfg.total_tool_count ?? 13,
  });
  $('mcp-kpi-token-mode').textContent = cfg.has_dedicated_token
    ? t('mcp.kpiTokenDedicated')
    : t('mcp.kpiTokenShared');
  $('mcp-kpi-token-preview').textContent = cfg.has_dedicated_token
    ? cfg.token_preview || '••••••••'
    : t('mcp.kpiTokenFollowAuth');
  $('mcp-kpi-source').textContent =
    cfg.source === 'persisted' ? t('mcp.kpiSourcePersisted') : t('mcp.kpiSourceEnv');

  $('mcp-toggle-enabled').checked = Boolean(cfg.enabled);
  $('mcp-toggle-readonly').checked = Boolean(cfg.read_only);
  $('btn-mcp-clear-token').disabled = !cfg.has_dedicated_token;

  $('mcp-token-desc').textContent = cfg.has_dedicated_token
    ? t('mcp.tokenDescDedicated', { preview: cfg.token_preview || '••••••••' })
    : t('mcp.tokenDescShared');

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
  for (const item of tools) {
    const cell = document.createElement('div');
    cell.className = 'module-cell';

    const head = document.createElement('div');
    head.className = 'module-head';

    const name = document.createElement('span');
    name.className = 'module-name';
    name.textContent = item.name;

    const flag = document.createElement('span');
    if (!cfg.enabled) {
      flag.className = 'module-flag off';
      flag.textContent = t('mcp.flagServiceOff');
    } else if (item.allowed) {
      flag.className = 'module-flag on';
      flag.textContent = t('mcp.flagOpen');
    } else {
      flag.className = 'module-flag warn';
      flag.textContent = t('mcp.flagReadOnlyBlocked');
    }

    head.append(name, flag);

    const cat = document.createElement('div');
    cat.className = 'module-cat';
    cat.textContent = item.mutating ? t('mcp.catMutating') : t('mcp.catReadOnly');

    const descKey = `mcp.tools.${item.name}`;
    const desc = document.createElement('div');
    desc.className = 'module-desc';
    desc.textContent = hasKey(descKey) ? t(descKey) : (item.description || '');

    cell.append(head, cat, desc);
    grid.appendChild(cell);
  }
}

async function saveMcpSettings(extraPayload = {}, successKey = 'mcp.toastSaved') {
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
    showToast(hasKey(successKey) ? t(successKey) : successKey);
  } catch (err) {
    showToast(t('mcp.toastUpdateFailed', { msg: err.message }), 'err');
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

    const titleKey = `templates.${tpl.id}.shortName`;
    const descKey = `templates.${tpl.id}.description`;

    const title = document.createElement('div');
    title.className = 'template-option-title';
    title.textContent = hasKey(titleKey) ? t(titleKey) : tpl.shortName;

    const desc = document.createElement('div');
    desc.className = 'template-option-desc';
    desc.textContent = hasKey(descKey) ? t(descKey) : tpl.description;

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
    $('new-site-error').textContent = localizeApiError(check);
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
  showToast(t('sites.toastDraftCreated', { domain: check.normalized }));
}

function renderDnsProviderFields() {
  const provider = $('ssl-provider').value;
  const wrap = $('ssl-provider-fields');
  const existingValues = {};
  wrap.querySelectorAll('input[data-env-key]').forEach((inp) => {
    existingValues[inp.dataset.envKey] = inp.value;
  });

  wrap.textContent = '';
  const keys = DNS_PROVIDER_KEYS[provider] || [];
  for (const key of keys) {
    const div = document.createElement('div');
    div.className = 'field';
    const label = document.createElement('label');
    label.setAttribute('for', `dns-env-${key}`);
    const lblText = t(`modals.ssl.dnsFields.${key}.label`);
    label.textContent = `${lblText} (${key})`;
    const input = document.createElement('input');
    input.id = `dns-env-${key}`;
    input.type = 'password';
    input.className = 'input mono';
    input.dataset.envKey = key;
    input.placeholder = t(`modals.ssl.dnsFields.${key}.placeholder`);
    input.autocomplete = 'off';
    if (existingValues[key]) input.value = existingValues[key];
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
    $('ssl-form-error').textContent = localizeApiError(check);
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
  btn.textContent = t('modals.ssl.submittingBtn');

  try {
    await apiFetch('/api/ssl/issue', {
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
    showToast(t('certs.toastIssued', { domain: check.normalized }));
    await Promise.all([loadCerts(), loadSystemInfo()]);
  } catch (err) {
    $('ssl-form-error').textContent = err.message;
    $('ssl-form-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = t('modals.ssl.submitBtn');
  }
}

// ==================== REACTIVE LOCALE RE-RENDER ====================
function rerenderDynamicUI() {
  syncLangButtons();
  const isDark = document.documentElement.classList.contains('dark');
  $('theme-label').textContent = isDark ? t('common.themeLight') : t('common.themeDark');
  syncSidebarUser();

  if (VIEW_META[state.view]) {
    $('topbar-title').textContent = t(VIEW_META[state.view].titleKey);
  }
  if (state.sites.length > 0 || state.systemInfo) {
    updateTopbarSummary();
  }
  if (state.powStatus && state.powStatus.key) {
    setPowShieldStatus(state.powStatus.mode, state.powStatus.key, state.powStatus.params);
  }

  renderSiteList();
  if (state.activeSite) {
    updateSiteEditorToolbar();
    updateLineGutter($('site-textarea'), $('site-gutter'), $('site-status-left'));
  }
  if (state.mainConf.loaded) {
    updateLineGutter($('main-textarea'), $('main-gutter'), $('main-status-left'));
  }
  renderCertsTable();
  renderSystemInfo();
  renderMcpConfig();
  renderNewSiteTemplates();
  renderDnsProviderFields();
  renderAccountMeta();
  if (!$('acc-strength-wrap').hidden) {
    updatePasswordStrengthUI();
  }
}

// ==================== WIRE EVENTS ====================
function initEvents() {
  // Language switchers (login screen + workspace topbar)
  document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.langBtn;
      if (target && target !== getLocale()) {
        setLocale(target, { persist: true });
      }
    });
  });

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
    showToast(t('sites.toastTemplateApplied'));
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
      showToast(t('build.toastCopiedCmd'));
    } catch {
      showToast(t('build.toastManualCopyCmd'), 'ok');
    }
  });

  // MCP / Agent management view
  $('btn-mcp-refresh').addEventListener('click', loadMcpConfig);
  $('mcp-toggle-enabled').addEventListener('change', () => {
    const on = $('mcp-toggle-enabled').checked;
    saveMcpSettings({}, on ? 'mcp.toastEnabled' : 'mcp.toastDisabled');
  });
  $('mcp-toggle-readonly').addEventListener('change', () => {
    const ro = $('mcp-toggle-readonly').checked;
    saveMcpSettings({}, ro ? 'mcp.toastModeReadOnly' : 'mcp.toastModeReadWrite');
  });
  $('btn-mcp-rotate-token').addEventListener('click', () => {
    saveMcpSettings({ rotate_token: true }, 'mcp.toastRotated');
  });
  $('btn-mcp-clear-token').addEventListener('click', () => {
    saveMcpSettings({ clear_token: true }, 'mcp.toastCleared');
  });
  $('btn-mcp-copy-token').addEventListener('click', async () => {
    if (!state.freshMcpToken) return;
    try {
      await navigator.clipboard.writeText(state.freshMcpToken);
      showToast(t('mcp.toastCopiedToken'));
    } catch {
      showToast(t('mcp.toastManualCopyToken'), 'ok');
    }
  });
  $('btn-mcp-copy-json').addEventListener('click', async () => {
    const jsonText = $('mcp-client-json').textContent;
    try {
      await navigator.clipboard.writeText(jsonText);
      showToast(t('mcp.toastCopiedJson'));
    } catch {
      showToast(t('mcp.toastManualCopyJson'), 'ok');
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
initI18n();
onLocaleChange(rerenderDynamicUI);
initTheme();
initEvents();
syncLangButtons();
updateCustomDockerCommand();
fetchAuthChallenge();