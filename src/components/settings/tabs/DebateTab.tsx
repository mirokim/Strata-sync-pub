import { DebateSettingsContent } from '@/components/chat/debate/DebateSettingsContent'

export default function DebateTab() {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>토론 설정</h3>
      <DebateSettingsContent />
    </div>
  )
}
