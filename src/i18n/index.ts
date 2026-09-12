/**
 * i18n — the English string is the key, `ko` maps it to Korean.
 *
 *   const t = useT()                       // in components: re-renders when the language changes
 *   t('Target Vault')                      // → '대상 볼트' (or the English text when no entry exists)
 *   t('{n} of {total} documents', { n, total })
 *
 * Outside React (stores, services) call `t` directly — it reads the current language each time.
 * Translations live in src/i18n/ko/<area>.ts, one file per component area, merged in src/i18n/ko/index.ts.
 * A missing entry falls back to the English key, so partial translations never break the UI.
 */
import { useSettingsStore } from '@/stores/settingsStore'
import { ko } from './ko'

export type Language = 'ko' | 'en'
/** The setting: an explicit language, or follow the browser / OS ('system'). */
export type LanguageSetting = Language | 'system'

export const LANGUAGES: { id: LanguageSetting; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
]

type Dictionary = Record<string, string>
const DICTIONARIES: Record<Language, Dictionary> = { en: {}, ko }

export function systemLanguage(): Language {
  const tag = typeof navigator !== 'undefined' ? navigator.language : ''
  return tag.toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

export function resolveLanguage(setting: LanguageSetting | undefined): Language {
  return setting === 'ko' || setting === 'en' ? setting : systemLanguage()
}

export function currentLanguage(): Language {
  return resolveLanguage(useSettingsStore.getState().language)
}

const PLACEHOLDER = /\{(\w+)\}/g

/** Pure lookup: translate `text` into `lang`, then fill `{name}` placeholders from `vars`. */
export function translate(lang: Language, text: string, vars?: Record<string, string | number>): string {
  const out = DICTIONARIES[lang][text] ?? text
  return vars ? out.replace(PLACEHOLDER, (m, k) => (k in vars ? String(vars[k]) : m)) : out
}

export function t(text: string, vars?: Record<string, string | number>): string {
  return translate(currentLanguage(), text, vars)
}

/** Subscribes the component to the language setting and returns `t`. */
export function useT(): typeof t {
  useSettingsStore(s => s.language)
  return t
}

/** Keys present in the English UI but absent from `ko` — for the i18n coverage test. */
export function missingTranslations(keys: Iterable<string>, lang: Language = 'ko'): string[] {
  return [...keys].filter(k => !(k in DICTIONARIES[lang]))
}
