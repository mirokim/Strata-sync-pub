import type { ChatMessage, SpeakerId } from '@/types'
import { SPEAKER_CONFIG } from '@/lib/speakerConfig'

// ── Filename helper ────────────────────────────────────────────────────────────

function reportFilename(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `report_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.md`
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generates a markdown report string from a chat conversation.
 *
 * @param messages  Chat messages to include (streaming messages are skipped)
 * @param personas  Active persona IDs at the time of export
 */
export function generateChatReport(
  messages: ChatMessage[],
  personas: SpeakerId[],
): string {
  const now = new Date()
  const dateStr = now.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  const personaNames = personas.map(id => SPEAKER_CONFIG[id]?.label ?? id).join(', ')

  const lines: string[] = [
    `# 대화 보고서`,
    ``,
    `- **날짜**: ${dateStr} ${timeStr}`,
    `- **참여 페르소나**: ${personaNames || '없음'}`,
    `- **메시지 수**: ${messages.filter(m => !m.streaming).length}`,
    ``,
    `---`,
    ``,
  ]

  for (const msg of messages) {
    if (msg.streaming) continue

    const ts = new Date(msg.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    const speakerLabel = msg.role === 'user'
      ? '사용자'
      : (SPEAKER_CONFIG[msg.persona]?.label ?? msg.persona)

    lines.push(`### ${speakerLabel} — ${ts}`, ``)

    if (msg.attachments?.length) {
      for (const att of msg.attachments) lines.push(`> 📎 첨부: ${att.name}`)
      lines.push(``)
    }

    if (msg.content.trim()) lines.push(msg.content.trim(), ``)

    lines.push(`---`, ``)
  }

  return lines.join('\n')
}

/**
 * Triggers a browser download of the given markdown string as a .md file.
 */
export function downloadMarkdown(markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = reportFilename()
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1_000)
}
