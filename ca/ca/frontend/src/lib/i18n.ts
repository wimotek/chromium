import en from '../../../internal/i18n/locales/en.json';
import zhCN from '../../../internal/i18n/locales/zh-CN.json';
import ja from '../../../internal/i18n/locales/ja.json';
import de from '../../../internal/i18n/locales/de.json';
import ar from '../../../internal/i18n/locales/ar.json';

export type LocaleCode = 'en' | 'zh-CN' | 'ja' | 'de' | 'ar';
export type LocaleDict = typeof en;

export const LOCALES: Record<LocaleCode, LocaleDict> = {
  en,
  'zh-CN': zhCN,
  ja,
  de,
  ar,
};

export const LOCALE_OPTIONS: Array<{ code: LocaleCode; label: string; dir: 'ltr' | 'rtl' }> = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'zh-CN', label: '简体中文', dir: 'ltr' },
  { code: 'ja', label: '日本語', dir: 'ltr' },
  { code: 'de', label: 'Deutsch', dir: 'ltr' },
  { code: 'ar', label: 'العربية', dir: 'rtl' },
];

export function isRtlLocale(code: LocaleCode): boolean {
  return code === 'ar';
}
