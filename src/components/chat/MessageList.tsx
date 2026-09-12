import { useEffect, useRef } from 'react'
import { FileText } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import MessageBubble from './MessageBubble'

export default function MessageList() {
  const messages  = useChatStore(s => s.messages)
  const isLoading = useChatStore(s => s.isLoading)
  const openInEditor = useUIStore(s => s.openInEditor)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when a new message is added or loading state changes.
  // Intentionally NOT on [messages] — that fires on every streaming chunk, causing
  // hundreds of scrollIntoView calls per response.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, isLoading])

  const hasMessages = messages.length > 0

  return (
    <div
      className="flex-1 overflow-y-auto px-3 py-3"
      data-testid="message-list"
    >
      {!hasMessages && !isLoading ? (
        <div
          className="flex items-center justify-center h-full text-xs"
          style={{ color: 'var(--color-text-muted)' }}
        >
          대화를 시작하거나 빠른 질문을 선택하세요
        </div>
      ) : (
        <>
          {messages.map(msg => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {/* Typing indicator */}
          {isLoading && (
            <div
              className="flex gap-1 px-3 py-2 mb-3"
              data-testid="typing-indicator"
            >
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="rounded-full"
                  style={{
                    width: 6,
                    height: 6,
                    background: 'var(--color-text-muted)',
                    animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                  }}
                />
              ))}
            </div>
          )}

          {/* Report viewer button — appears after last message */}
          {hasMessages && !isLoading && (
            <div className="flex justify-center mt-3 mb-1">
              <button
                onClick={() => openInEditor('report:latest')}
                className="flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-full transition-colors hover:bg-[var(--color-bg-hover)]"
                style={{
                  color: 'var(--color-text-muted)',
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg-surface)',
                  cursor: 'pointer',
                }}
                title="대화 내용을 보고서로 보기"
              >
                <FileText size={10} />
                보고서 보기
              </button>
            </div>
          )}
        </>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
