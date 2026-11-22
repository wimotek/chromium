/**
 * Zero-dependency ESM i18n runtime for Wimotek Nginx Console.
 * Features:
 * - Locale persistence (localStorage), URL override (?lang=en|zh|pseudo), and navigator.languages auto-detection
 * - Native Intl.PluralRules pluralization (future-proof for Slavic/Arabic/European plural categories)
 * - Built-in pseudo-localization (?lang=pseudo) to stress-test layout against +40% string expansion
 * - Backend error_code + fallback localization
 */
import zhCN from './zh-CN.js';
import enUS from './en-US.js';

export const STORAGE_KEY = 'wimotek_nginx_lang';
export const DEFAULT_LOCALE = 'zh-CN';
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'];

export const MESSAGES = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

const LOCALE_ALIASES = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh-tw': 'zh-CN',
  'zh-hk': 'zh-CN',
  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-US',
  'en-au': 'en-US',
  'en-ca': 'en-US',
  pseudo: 'pseudo',
};

const PSEUDO_MAP = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'đ', e: 'é', f: 'ƒ', g: 'ğ', h: 'ħ',
  i: 'í', j: 'ĵ', k: 'ķ', l: 'ľ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'ƥ',
  q: 'ɋ', r: 'ř', s: 'ş', t: 'ŧ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ',
  y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ğ', H: 'Ħ',
  I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ľ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Ƥ',
  Q: 'Ɋ', R: 'Ř', S: 'Ş', T: 'Ŧ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ',
  Y: 'Ý', Z: 'Ž',
};

let currentLocale = DEFAULT_LOCALE;
const listeners = new Set();

/**
 * Normalizes a BCP-47 locale tag or short alias into a supported locale code.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeLocale(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s) return null;
  if (LOCALE_ALIASES[s]) return LOCALE_ALIASES[s];
  const primary = s.split('-')[0];
  if (LOCALE_ALIASES[primary]) return LOCALE_ALIASES[primary];
  return null;
}

/**
 * Generates pseudo-localized text (+~35-40% expansion) while keeping `{placeholders}` intact.
 * Useful for verifying layout resilience before adding verbose languages like German or Russian.
 * @param {string} str
 * @returns {string}
 */
export function pseudoLocalize(str) {
  const text = String(str ?? '');
  if (!text) return '';
  let out = '';
  let inBrace = false;
  let visibleLen = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      inBrace = true;
      out += ch;
      continue;
    }
    if (ch === '}') {
      inBrace = false;
      out += ch;
      continue;
    }
    if (inBrace) {
      out += ch;
      continue;
    }
    visibleLen++;
    out += PSEUDO_MAP[ch] || ch;
  }

  const padLen = Math.max(2, Math.round(visibleLen * 0.35));
  const pad = 'x'.repeat(Math.min(padLen, 16));
  return `[!! ${out} ${pad} !!]`;
}

function getByPath(obj, key) {
  if (!obj || !key) return undefined;
  const parts = String(key).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) {
      return undefined;
    }
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(template, params) {
  if (!params || typeof params !== 'object') return template;
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null) {
      return String(params[name]);
    }
    return match;
  });
}

/**
 * Returns the active locale code ('zh-CN', 'en-US', or 'pseudo').
 */
export function getLocale() {
  return currentLocale;
}

/**
 * Detects initial locale from query string, localStorage, or browser preferences.
 */
export function detectInitialLocale() {
  try {
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      const qs = new URLSearchParams(window.location.search);
      const fromUrl = normalizeLocale(qs.get('lang'));
      if (fromUrl) return fromUrl;
    }
  } catch {
    // ignore URL errors
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = normalizeLocale(window.localStorage.getItem(STORAGE_KEY));
      if (saved && saved !== 'pseudo') return saved;
    }
  } catch {
    // ignore storage restrictions
  }

  try {
    if (typeof navigator !== 'undefined') {
      const langs = Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language];
      for (const lang of langs) {
        const matched = normalizeLocale(lang);
        if (matched) return matched;
      }
      if (langs.length > 0 && langs[0]) {
        return 'en-US';
      }
    }
  } catch {
    // ignore navigator access issues
  }

  return DEFAULT_LOCALE;
}

/**
 * Looks up a translation key with `{param}` interpolation and automatic fallback chain.
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @param {string} [localeOverride]
 */
export function t(key, params, localeOverride) {
  const loc = localeOverride || currentLocale;
  const isPseudo = loc === 'pseudo';
  const lookupLocale = isPseudo ? 'en-US' : loc;

  let raw = getByPath(MESSAGES[lookupLocale], key);
  if (raw === undefined) raw = getByPath(MESSAGES['en-US'], key);
  if (raw === undefined) raw = getByPath(MESSAGES[DEFAULT_LOCALE], key);
  if (raw === undefined) return key;

  const formatted = isPseudo ? pseudoLocalize(raw) : raw;
  return interpolate(formatted, params);
}

/**
 * Translates pluralized keys using native Intl.PluralRules.
 * Expects dictionary entries like `${baseKey}_one`, `${baseKey}_other`, `${baseKey}_few`, etc.
 * @param {string} baseKey
 * @param {number} count
 * @param {Record<string, string | number>} [params]
 * @param {string} [localeOverride]
 */
export function tPlural(baseKey, count, params = {}, localeOverride) {
  const loc = localeOverride || currentLocale;
  const effectiveLocale = loc === 'pseudo' ? 'en-US' : loc;
  let category = 'other';
  try {
    category = new Intl.PluralRules(effectiveLocale).select(Math.abs(Number(count) || 0));
  } catch {
    category = Math.abs(Number(count) || 0) === 1 ? 'one' : 'other';
  }

  const dict = MESSAGES[effectiveLocale] || MESSAGES['en-US'];
  const specificKey = `${baseKey}_${category}`;
  const fallbackKey = `${baseKey}_other`;
  const chosenKey = getByPath(dict, specificKey) !== undefined ? specificKey : fallbackKey;
  return t(chosenKey, { count, ...params }, loc);
}

/**
 * Checks whether a translation key exists in a given locale.
 * @param {string} key
 * @param {string} [localeOverride]
 */
export function hasKey(key, localeOverride) {
  const loc = localeOverride || currentLocale;
  const lookupLocale = loc === 'pseudo' ? 'en-US' : loc;
  return getByPath(MESSAGES[lookupLocale], key) !== undefined;
}

/**
 * Maps a backend error payload (or Error with .errorCode) to a localized message.
 * Preserves backward compatibility with backends returning only plain `error` strings.
 * @param {{ errorCode?: string, error_code?: string, errorParams?: object, error_params?: object, retryAfter?: number, retry_after?: number, message?: string, error?: string, status?: number }} errLike
 */
export function localizeApiError(errLike) {
  if (!errLike) return t('common.actionFailedDefault');
  const code = errLike.errorCode || errLike.error_code || '';
  const params = {
    ...(errLike.errorParams || errLike.error_params || {}),
  };
  if (errLike.retryAfter && !params.retry_after) params.retry_after = errLike.retryAfter;
  if (errLike.retry_after && !params.retry_after) params.retry_after = errLike.retry_after;
  if (errLike.status && !params.status) params.status = errLike.status;

  if (code && hasKey(`errors.${code}`)) {
    return t(`errors.${code}`, params);
  }

  // Fallback mapping for Go/legacy responses that haven't attached error_code
  const raw = String(errLike.message || errLike.error || '').trim();
  if (raw) {
    if (raw.includes('未授权') || raw.includes('会话已失效')) return t('errors.ERR_UNAUTHORIZED');
    if (raw.includes('请求参数格式非法')) return t('errors.ERR_INVALID_PARAMS');
    if (raw.includes('授权 Token 无效')) return t('errors.ERR_TOKEN_INVALID');
    if (raw.includes('账号或密码连续错误')) {
      return t('errors.ERR_CREDENTIALS_LOCKED', { retry_after: params.retry_after || 15 });
    }
    if (raw.includes('账号或密码错误')) return t('errors.ERR_CREDENTIALS_INVALID');
    if (raw.includes('图形验证码错误')) return t('errors.ERR_CAPTCHA_INVALID');
    if (raw.includes('安全算力校验未通过')) return t('errors.ERR_POW_INVALID');
    if (raw.includes('安全验证已过期')) return t('errors.ERR_CHALLENGE_EXPIRED');
    if (raw.includes('提交速度异常过快')) return t('errors.ERR_SUBMIT_TOO_FAST');
    if (raw.includes('自动化异常提交')) return t('errors.ERR_HONEYPOT_TRIGGERED');
    if (raw.includes('当前密码校验失败')) return t('errors.ERR_CURRENT_PASS_INVALID');
    return raw;
  }

  if (params.status) {
    return t('errors.ERR_REQUEST_FAILED', { status: params.status });
  }
  return t('common.actionFailedDefault');
}

/**
 * Applies translations to all declarative `[data-i18n*]` DOM attributes under `root`.
 * Never uses innerHTML — strictly updates textContent & safe attributes.
 * @param {ParentNode} [root]
 */
export function applyDomTranslations(root) {
  if (typeof document === 'undefined') return;
  const scope = root || document;

  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  });
  scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key));
  });
  scope.querySelectorAll('[data-i18n-alt]').forEach((el) => {
    const key = el.getAttribute('data-i18n-alt');
    if (key) el.setAttribute('alt', t(key));
  });

  if (scope === document) {
    const effective = currentLocale === 'pseudo' ? 'en-US' : currentLocale;
    const meta = MESSAGES[effective]?.meta || MESSAGES[DEFAULT_LOCALE].meta;
    document.documentElement.lang = effective;
    document.documentElement.dir = meta.dir || 'ltr';
    document.title = t('meta.pageTitle');
    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute('content', t('meta.pageDescription'));
  }
}

/**
 * Switches active locale, updates DOM attributes, persists preference, and notifies subscribers.
 * @param {string} nextLocale
 * @param {{ persist?: boolean }} [opts]
 */
export function setLocale(nextLocale, opts = { persist: true }) {
  const normalized = normalizeLocale(nextLocale) || DEFAULT_LOCALE;
  currentLocale = normalized;

  if (opts.persist !== false && normalized !== 'pseudo') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, normalized);
      }
    } catch {
      // ignore storage errors
    }
  }

  applyDomTranslations(typeof document !== 'undefined' ? document : undefined);

  for (const cb of listeners) {
    try {
      cb(currentLocale);
    } catch {
      // keep other subscribers running
    }
  }

  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('wimotek:locale-change', { detail: { locale: currentLocale } }));
  }

  return currentLocale;
}

/**
 * Registers a callback fired whenever the locale changes.
 * @param {(locale: string) => void} cb
 */
export function onLocaleChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Initializes locale from URL/storage/browser and exposes a global bridge for non-module scripts.
 */
export function initI18n() {
  const initial = detectInitialLocale();
  setLocale(initial, { persist: false });

  if (typeof window !== 'undefined') {
    window.__WIMOTEK_I18N__ = {
      t,
      tPlural,
      getLocale,
      setLocale,
      onLocaleChange,
      SUPPORTED_LOCALES,
    };
  }
  return initial;
}
