import type { DirectorId, ProviderId } from '@/types'

// ── Provider identity ─────────────────────────────────────────────────────────

/** Re-exported from @/types — canonical definition lives in @/types. */
export type { ProviderId } from '@/types'

// ── Model catalogue ───────────────────────────────────────────────────────────

export interface ModelOption {
  id: string
  label: string
  provider: ProviderId
}

export const MODEL_OPTIONS: ModelOption[] = [
  // ── Anthropic (Claude) ──
  { id: 'claude-opus-4-6',            label: 'Claude Opus 4.6',       provider: 'anthropic' },
  { id: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6',     provider: 'anthropic' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',      provider: 'anthropic' },
  { id: 'claude-sonnet-4-5-20250514', label: 'Claude Sonnet 4.5',     provider: 'anthropic' },

  // ── OpenAI (GPT) ──
  { id: 'gpt-4.1',                    label: 'GPT-4.1',               provider: 'openai'    },
  { id: 'gpt-4.1-mini',               label: 'GPT-4.1 Mini',          provider: 'openai'    },
  { id: 'gpt-4o',                     label: 'GPT-4o',                provider: 'openai'    },
  { id: 'o3',                         label: 'o3',                    provider: 'openai'    },
  { id: 'o4-mini',                    label: 'o4-mini',               provider: 'openai'    },

  // ── Google (Gemini) ──
  { id: 'gemini-2.5-pro',             label: 'Gemini 2.5 Pro',        provider: 'gemini'    },
  { id: 'gemini-2.5-flash',           label: 'Gemini 2.5 Flash',      provider: 'gemini'    },
  { id: 'gemini-2.5-flash-lite',      label: 'Gemini 2.5 Flash Lite', provider: 'gemini'    },

  // ── xAI (Grok) ──
  { id: 'grok-3',                     label: 'Grok 3',                provider: 'grok'      },
  { id: 'grok-3-mini',                label: 'Grok 3 Mini',           provider: 'grok'      },
]

// ── Default persona → model mapping ──────────────────────────────────────────

export const DEFAULT_PERSONA_MODELS: Record<DirectorId, string> = {
  chief_director: 'claude-sonnet-4-6',
  art_director:   'claude-sonnet-4-6',
  plan_director:  'claude-sonnet-4-6',
  level_director: 'claude-sonnet-4-6',
  prog_director:  'claude-sonnet-4-6',
}

// ── Per-provider default models ───────────────────────────────────────────────

/** Cheapest/fastest worker model per provider (background tasks, summarisation) */
export const WORKER_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai:    'gpt-4.1-mini',
  gemini:    'gemini-2.5-flash-lite',
  grok:      'grok-3-mini',
}

/** Standard default model per provider (debate fallback, general use) */
export const DEFAULT_MODELS_BY_PROVIDER: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4.1',
  gemini:    'gemini-2.5-flash',
  grok:      'grok-3',
}

// ── Helper ────────────────────────────────────────────────────────────────────

/** Get provider for a given model ID. Returns undefined if model not found. */
export function getProviderForModel(modelId: string): ProviderId | undefined {
  return MODEL_OPTIONS.find((m) => m.id === modelId)?.provider
}

/** Get VITE env var name for a given provider */
export function envKeyForProvider(provider: ProviderId): string {
  return `VITE_${provider.toUpperCase()}_API_KEY`
}
