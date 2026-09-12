/**
 * SettingsPanel — Full-area tab panel (replaces old modal popup).
 *
 * Layout: fills its container (center editor area in MainLayout)
 *   Left  186px : nav sidebar (도구 / 설정 / 기타 groups)
 *   Right rest  : content area (header + scrollable body + footer)
 */

import { useState } from 'react'
import {
  X, BarChart2, Trash2,
  Settings, Cpu, GitMerge, Keyboard, Info,
  Layers, Clock,
  Users, Tag, Download, Bot, Database, Search, Fish, Pencil, Coins, Send,
  Link2, Wand2, HardDrive, Sparkles,
} from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import GeneralTab from './tabs/GeneralTab'
import AITab from './tabs/AITab'
import PersonasTab from './tabs/PersonasTab'
import DebateTab from './tabs/DebateTab'
import ProjectTab from './tabs/ProjectTab'
import AboutTab from './tabs/AboutTab'
import TagsTab from './tabs/TagsTab'
import StatsTab from './tabs/StatsTab'
import TrashTab from './tabs/TrashTab'
import ShortcutsTab from './tabs/ShortcutsTab'
import ConfluenceTab from './tabs/ConfluenceTab'
import SlackBotTab from './tabs/SlackBotTab'
import JiraTab from './tabs/JiraTab'
import VaultManagerTab from './tabs/VaultManagerTab'
import SearchTab from './tabs/SearchTab'
import VectorEmbedTab from './tabs/VectorEmbedTab'
import MirofishTab from './tabs/MirofishTab'
import EditAgentTab from './tabs/EditAgentTab'
import UsageTab from './tabs/UsageTab'
import JiraDispatchTab from './tabs/JiraDispatchTab'
import ConfluencePublishTab from './tabs/ConfluencePublishTab'
import CronJobTab from './tabs/CronJobTab'

// ── Types ─────────────────────────────────────────────────────────────────────

type SettingsTab =
  | 'stats' | 'trash'
  | 'general' | 'ai' | 'search' | 'vector-embed' | 'personas' | 'debate' | 'shortcuts' | 'project' | 'tags'
  | 'confluence' | 'confluence-publish' | 'slack-bot' | 'jira' | 'jira-dispatch' | 'vault-manager' | 'mirofish'
  | 'edit-agent' | 'cron-jobs' | 'usage'
  | 'about'

type NavItem = { id: SettingsTab; icon: React.ElementType; label: string }
type NavGroup = { label: string; items: NavItem[] }

// ── Navigation structure ──────────────────────────────────────────────────────

const NAV: NavGroup[] = [
  {
    label: '연동',
    items: [
      { id: 'confluence',         icon: Download, label: 'Confluence 가져오기' },
      { id: 'confluence-publish', icon: Send,     label: 'Confluence 발행' },
      { id: 'jira',               icon: Download, label: 'Jira 가져오기' },
      { id: 'jira-dispatch',      icon: Send,     label: 'Jira 일감 발행' },
      { id: 'slack-bot',          icon: Bot,      label: 'Slack 봇' },
    ],
  },
  {
    label: '에이전트',
    items: [
      { id: 'edit-agent', icon: Wand2, label: '편집 에이전트' },
      { id: 'cron-jobs',  icon: Clock, label: '크론잡' },
      { id: 'mirofish',   icon: Fish,  label: 'MiroFish' },
    ],
  },
  {
    label: '볼트',
    items: [
      { id: 'stats',         icon: BarChart2, label: '통계' },
      { id: 'vault-manager', icon: HardDrive, label: '볼트 관리자' },
      { id: 'usage',         icon: Coins,     label: '토큰 사용량' },
      { id: 'trash',         icon: Trash2,    label: '휴지통' },
    ],
  },
  {
    label: '설정',
    items: [
      { id: 'general',   icon: Settings,  label: '일반' },
      { id: 'ai',        icon: Cpu,       label: 'AI 설정' },
      { id: 'search',       icon: Search,    label: '검색 튜닝' },
      { id: 'vector-embed', icon: Sparkles,  label: '벡터 임베딩' },
      { id: 'tags',      icon: Tag,       label: '태그' },
      { id: 'personas',  icon: Users,     label: '페르소나' },
      { id: 'project',   icon: Layers,    label: '프로젝트' },
      { id: 'debate',    icon: GitMerge,  label: '토론' },
      { id: 'shortcuts', icon: Keyboard,  label: '단축키' },
    ],
  },
  {
    label: '기타',
    items: [
      { id: 'about', icon: Info, label: '정보' },
    ],
  },
]

const ALL_ITEMS = NAV.flatMap(g => g.items)

// ── Tab content dispatcher ────────────────────────────────────────────────────

function renderTabContent(tab: SettingsTab) {
  switch (tab) {
    case 'stats':      return <StatsTab />
    case 'trash':      return <TrashTab />
    case 'general':    return <GeneralTab />
    case 'ai':         return <AITab />
    case 'search':        return <SearchTab />
    case 'vector-embed':  return <VectorEmbedTab />
    case 'personas':   return <PersonasTab />
    case 'project':    return <ProjectTab />
    case 'debate':     return <DebateTab />
    case 'tags':       return <TagsTab />
    case 'shortcuts':  return <ShortcutsTab />
    case 'confluence':         return <ConfluenceTab />
    case 'confluence-publish': return <ConfluencePublishTab />
    case 'jira':               return <JiraTab />
    case 'jira-dispatch': return <JiraDispatchTab />
    case 'slack-bot':     return <SlackBotTab />
    case 'vault-manager': return <VaultManagerTab />
    case 'mirofish':   return <MirofishTab />
    case 'edit-agent': return <EditAgentTab />
    case 'cron-jobs':  return <CronJobTab />
    case 'usage':      return <UsageTab />
    case 'about':      return <AboutTab />
    default:           return null
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SettingsPanel() {
  const { resetPersonaModels } = useSettingsStore()
  const setCenterTab = useUIStore(s => s.setCenterTab)
  const [activeTab, setActiveTab] = useState<SettingsTab>('ai')

  const activeLabel = ALL_ITEMS.find(i => i.id === activeTab)?.label ?? ''
  const close = () => setCenterTab('graph')

  return (
    <div className="flex h-full overflow-hidden" data-testid="settings-panel">

      {/* ── Left sidebar ──────────────────────────────────────────── */}
      <div
        className="flex flex-col shrink-0"
        style={{
          width: 210,
          borderRight: '1px solid var(--color-border)',
          background: 'var(--color-bg-primary)',
        }}
      >
        {/* Sidebar header */}
        <div
          className="flex items-center px-4 h-11 shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
            설정
          </span>
        </div>

        {/* Nav groups */}
        <div className="flex-1 overflow-y-auto py-2">
          {NAV.map((group, gi) => (
            <div key={group.label} className={gi > 0 ? 'mt-3' : ''}>
              <div
                className="px-4 pb-1 text-xs font-semibold tracking-wider uppercase"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {group.label}
              </div>

              {group.items.map(item => {
                const Icon = item.icon
                const active = activeTab === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className="w-full flex items-center gap-2.5 py-2 text-[13px] transition-colors text-left"
                    style={{
                      paddingLeft: active ? 14 : 16,
                      paddingRight: 16,
                      background: active ? 'var(--color-bg-hover)' : 'transparent',
                      color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
                      fontWeight: active ? 500 : 400,
                      borderLeft: active ? '2px solid var(--color-accent)' : '2px solid transparent',
                    }}
                  >
                    <Icon size={14} />
                    {item.label}
                  </button>
                )
              })}

              {gi < NAV.length - 1 && (
                <div className="mx-4 mt-3" style={{ borderTop: '1px solid var(--color-border)' }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Right content ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Content header */}
        <div
          className="flex items-center justify-between px-6 h-11 shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            {activeLabel}
          </span>
          <button
            onClick={close}
            className="p-1 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
            style={{ color: 'var(--color-text-muted)' }}
            aria-label="닫기"
            data-testid="settings-close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {renderTabContent(activeTab)}
        </div>

        {/* Footer */}
        <div
          className="px-6 py-3 shrink-0 flex items-center justify-between"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          <button
            onClick={resetPersonaModels}
            className="text-[13px] px-3 py-2 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
            style={{ color: 'var(--color-text-muted)' }}
            data-testid="settings-reset"
          >
            기본값으로 초기화
          </button>
          <button
            onClick={close}
            className="text-[13px] px-4 py-2 rounded transition-colors"
            style={{ background: 'var(--color-accent)', color: '#fff' }}
            data-testid="settings-save"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
