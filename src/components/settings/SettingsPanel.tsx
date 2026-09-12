/**
 * SettingsPanel — Full-area tab panel (replaces old modal popup).
 *
 * Layout: fills its container (center editor area in MainLayout)
 *   Left  186px : nav sidebar (Tools / Settings / Other groups)
 *   Right rest  : content area (header + scrollable body + footer)
 */

import { useState } from 'react'
import {
  X, BarChart2, Trash2,
  Settings, Cpu, GitMerge, Keyboard, Info,
  Layers, Clock,
  Users, Tag, Download, Bot, Database, Search, Fish, Pencil, Coins, Send,
  Link2, Wand2, HardDrive, Sparkles, Cloud,
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
import TeamSyncTab from './tabs/TeamSyncTab'
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
  | 'edit-agent' | 'cron-jobs' | 'usage' | 'team-sync'
  | 'about'

type NavItem = { id: SettingsTab; icon: React.ElementType; label: string }
type NavGroup = { label: string; items: NavItem[] }

// ── Navigation structure ──────────────────────────────────────────────────────

const NAV: NavGroup[] = [
  {
    label: 'Integrations',
    items: [
      { id: 'confluence',         icon: Download, label: 'Confluence Import' },
      { id: 'confluence-publish', icon: Send,     label: 'Confluence Publish' },
      { id: 'jira',               icon: Download, label: 'Jira Import' },
      { id: 'jira-dispatch',      icon: Send,     label: 'Jira Dispatch' },
      { id: 'slack-bot',          icon: Bot,      label: 'Slack Bot' },
    ],
  },
  {
    label: 'Agents',
    items: [
      { id: 'edit-agent', icon: Wand2, label: 'Edit Agent' },
      { id: 'cron-jobs',  icon: Clock, label: 'Cron Jobs' },
      { id: 'mirofish',   icon: Fish,  label: 'MiroFish' },
    ],
  },
  {
    label: 'Vault',
    items: [
      { id: 'stats',         icon: BarChart2, label: 'Statistics' },
      { id: 'vault-manager', icon: HardDrive, label: 'Vault Manager' },
      { id: 'team-sync',     icon: Cloud,     label: 'Team Sync' },
      { id: 'usage',         icon: Coins,     label: 'Token Usage' },
      { id: 'trash',         icon: Trash2,    label: 'Trash' },
    ],
  },
  {
    label: 'Settings',
    items: [
      { id: 'general',   icon: Settings,  label: 'General' },
      { id: 'ai',        icon: Cpu,       label: 'AI Settings' },
      { id: 'search',       icon: Search,    label: 'Search Tuning' },
      { id: 'vector-embed', icon: Sparkles,  label: 'Vector Embed' },
      { id: 'tags',      icon: Tag,       label: 'Tags' },
      { id: 'personas',  icon: Users,     label: 'Personas' },
      { id: 'project',   icon: Layers,    label: 'Project' },
      { id: 'debate',    icon: GitMerge,  label: 'Debate' },
      { id: 'shortcuts', icon: Keyboard,  label: 'Shortcuts' },
    ],
  },
  {
    label: 'Other',
    items: [
      { id: 'about', icon: Info, label: 'About' },
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
    case 'team-sync':     return <TeamSyncTab />
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
            Settings
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
            aria-label="Close"
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
            Reset to Defaults
          </button>
          <button
            onClick={close}
            className="text-[13px] px-4 py-2 rounded transition-colors"
            style={{ background: 'var(--color-accent)', color: '#fff' }}
            data-testid="settings-save"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
