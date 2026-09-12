import { describe, it, expect, beforeEach } from 'vitest'
import { translate, resolveLanguage, t, missingTranslations } from '@/i18n'
import { ko } from '@/i18n/ko'
import { useSettingsStore } from '@/stores/settingsStore'

describe('i18n', () => {
  beforeEach(() => useSettingsStore.setState({ language: 'system' }))

  it('falls back to the English key when no translation exists', () => {
    expect(translate('ko', 'No such string anywhere')).toBe('No such string anywhere')
    expect(translate('en', 'Language')).toBe('Language')
  })

  it('fills {placeholders} and leaves unknown ones alone', () => {
    expect(translate('en', '{n} of {total} documents', { n: 3, total: 10 })).toBe('3 of 10 documents')
    expect(translate('en', 'Hello {name}', {})).toBe('Hello {name}')
  })

  it('resolves the system setting from the browser language', () => {
    expect(resolveLanguage('ko')).toBe('ko')
    expect(resolveLanguage('en')).toBe('en')
    expect(['ko', 'en']).toContain(resolveLanguage('system'))
  })

  it('t() reads the current setting from the store', () => {
    useSettingsStore.setState({ language: 'ko' })
    expect(t('Language')).toBe(ko['Language'] ?? 'Language')
    useSettingsStore.setState({ language: 'en' })
    expect(t('Language')).toBe('Language')
  })

  it('every Korean entry is a non-empty string whose placeholders match the key', () => {
    const bad: string[] = []
    for (const [key, value] of Object.entries(ko)) {
      if (typeof value !== 'string' || !value.trim()) { bad.push(key); continue }
      const keyVars = [...key.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
      const valVars = [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
      if (keyVars.join(',') !== valVars.join(',')) bad.push(key)
    }
    expect(bad).toEqual([])
  })

  it('reports keys that are not translated', () => {
    expect(missingTranslations(['Language', 'Definitely not translated'])).toContain('Definitely not translated')
  })
})
