import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, Download } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { generateChatReport, downloadMarkdown } from '@/lib/chatReport'
import { streamAIReport } from '@/services/reportClient'

/**
 * ReportViewer — 채팅 대화를 마크다운 보고서로 미리 보여주는 에디터 뷰.
 * editingDocId = 'report:latest' 형태일 때 렌더링됨.
 * 볼트에 저장하지 않고 다운로드만 가능.
 *
 * reportModelId 가 설정된 경우: AI 스트리밍 보고서 생성
 * reportModelId 가 비어있는 경우: generateChatReport() 정적 포맷 사용
 */
export default function ReportViewer() {
  const { closeEditor } = useUIStore()
  const messages = useChatStore.getState().messages
  const activePersonas = useChatStore.getState().activePersonas
  const { reportModelId } = useSettingsStore.getState()

  const [markdown, setMarkdown] = useState<string>('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!reportModelId) {
      // Static format — no AI needed
      setMarkdown(generateChatReport(messages, activePersonas))
      return
    }

    // AI streaming
    setIsStreaming(true)
    setError(null)
    setMarkdown('')

    streamAIReport(messages, chunk => {
      setMarkdown(prev => prev + chunk)
    })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        // Fall back to static format on error
        setMarkdown(generateChatReport(messages, activePersonas))
      })
      .finally(() => setIsStreaming(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* 헤더 */}
      <div
        className="shrink-0 flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <span
          className="text-xs font-mono"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          📄 대화 보고서{reportModelId ? ' (AI)' : ''}
        </span>

        <div className="flex items-center gap-1">
          {isStreaming && (
            <span
              className="text-[10px] px-2"
              style={{ color: 'var(--color-text-muted)' }}
            >
              생성 중…
            </span>
          )}

          <button
            onClick={() => downloadMarkdown(markdown)}
            disabled={!markdown || isStreaming}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              color: 'var(--color-accent, #60a5fa)',
              border: '1px solid var(--color-accent, #60a5fa)',
              background: 'transparent',
            }}
            title="마크다운 파일로 다운로드"
          >
            <Download size={11} />
            다운로드
          </button>

          <button
            onClick={closeEditor}
            className="p-1 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
            style={{ color: 'var(--color-text-muted)' }}
            aria-label="보고서 닫기"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* 오류 배너 */}
      {error && (
        <div
          className="shrink-0 px-4 py-2 text-xs"
          style={{
            background: 'var(--color-error-bg)',
            borderBottom: '1px solid var(--color-error-border)',
            color: 'var(--color-error)',
          }}
        >
          AI 생성 실패 — 기본 형식으로 대체: {error}
        </div>
      )}

      {/* 보고서 본문 */}
      <div
        className="flex-1 overflow-y-auto px-6 py-5"
        style={{ color: 'var(--color-text-primary)', wordBreak: 'keep-all', overflowWrap: 'break-word' }}
      >
        {!markdown && isStreaming ? (
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            보고서를 생성하고 있습니다…
          </div>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => (
                <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12, color: 'var(--color-text-primary)' }}>
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2 style={{ fontSize: 15, fontWeight: 600, marginTop: 20, marginBottom: 8, color: 'var(--color-text-primary)' }}>
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 style={{ fontSize: 13, fontWeight: 600, marginTop: 20, marginBottom: 4, color: 'var(--color-text-secondary)' }}>
                  {children}
                </h3>
              ),
              p: ({ children }) => (
                <p style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 8, color: 'var(--color-text-primary)' }}>
                  {children}
                </p>
              ),
              li: ({ children }) => (
                <li style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--color-text-secondary)', marginBottom: 2 }}>
                  {children}
                </li>
              ),
              hr: () => (
                <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '12px 0' }} />
              ),
              blockquote: ({ children }) => (
                <blockquote style={{ borderLeft: '2px solid var(--color-border)', paddingLeft: 10, margin: '6px 0', color: 'var(--color-text-muted)', fontSize: 12 }}>
                  {children}
                </blockquote>
              ),
              strong: ({ children }) => (
                <strong style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                  {children}
                </strong>
              ),
              code: ({ children }) => (
                <code style={{ fontFamily: 'var(--ea-font-mono)', fontSize: 11, background: 'var(--color-bg-surface)', padding: '1px 4px', borderRadius: 3 }}>
                  {children}
                </code>
              ),
            }}
          >
            {markdown}
          </ReactMarkdown>
        )}
      </div>
    </div>
  )
}
