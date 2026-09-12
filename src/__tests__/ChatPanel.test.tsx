import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { useChatStore } from '@/stores/chatStore'

let ChatPanel: typeof import('@/components/chat/ChatPanel').default

beforeEach(async () => {
  vi.useFakeTimers()
  useChatStore.setState({
    activePersonas: ['chief_director'],
    messages: [],
    isLoading: false,
  })
  const mod = await import('@/components/chat/ChatPanel')
  ChatPanel = mod.default
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('ChatPanel — structure', () => {
  it('renders the chat panel container', () => {
    render(<ChatPanel />)
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument()
  })

  it('renders persona chips', () => {
    render(<ChatPanel />)
    expect(screen.getByTestId('persona-chips')).toBeInTheDocument()
  })

  it('renders message list', () => {
    render(<ChatPanel />)
    expect(screen.getByTestId('message-list')).toBeInTheDocument()
  })

  it('renders quick questions', () => {
    render(<ChatPanel />)
    expect(screen.getByTestId('quick-questions')).toBeInTheDocument()
  })

  it('renders chat input', () => {
    render(<ChatPanel />)
    expect(screen.getByTestId('chat-input-container')).toBeInTheDocument()
  })

})

describe('PersonaChips — PM only', () => {
  it('renders exactly 1 persona chip (PM)', () => {
    render(<ChatPanel />)
    const chips = screen.getAllByTestId(/^persona-chip-/)
    expect(chips.length).toBe(1)
  })

  it('PM chip is always active', () => {
    render(<ChatPanel />)
    const chip = screen.getByTestId('persona-chip-chief_director')
    expect(chip).toHaveAttribute('data-active', 'true')
  })
})

describe('ChatInput — send', () => {
  it('renders the textarea', () => {
    render(<ChatPanel />)
    expect(screen.getByTestId('chat-textarea')).toBeInTheDocument()
  })

  it('renders the send button', () => {
    render(<ChatPanel />)
    expect(screen.getByTestId('chat-send-button')).toBeInTheDocument()
  })

  it('typing in textarea updates value', () => {
    render(<ChatPanel />)
    const textarea = screen.getByTestId('chat-textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Hello world' } })
    expect(textarea.value).toBe('Hello world')
  })

  it('pressing Enter sends the message and adds user message', async () => {
    render(<ChatPanel />)
    const textarea = screen.getByTestId('chat-textarea')
    fireEvent.change(textarea, { target: { value: '테스트 질문' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    const msgs = useChatStore.getState().messages
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('테스트 질문')
  })

  it('pressing Shift+Enter does not send (allows newline)', () => {
    render(<ChatPanel />)
    const textarea = screen.getByTestId('chat-textarea')
    fireEvent.change(textarea, { target: { value: '줄바꿈 테스트' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    // Message should NOT be sent
    expect(useChatStore.getState().messages.length).toBe(0)
  })
})

describe('MessageList — messages', () => {
  it('shows empty state when no messages', () => {
    render(<ChatPanel />)
    expect(screen.getByTestId('message-list')).toBeInTheDocument()
    expect(useChatStore.getState().messages).toHaveLength(0)
  })

  it('shows typing indicator while loading', () => {
    useChatStore.setState({ ...useChatStore.getState(), isLoading: true })
    render(<ChatPanel />)
    expect(screen.getByTestId('typing-indicator')).toBeInTheDocument()
  })

  it('shows user message after sending', async () => {
    render(<ChatPanel />)
    const textarea = screen.getByTestId('chat-textarea')
    fireEvent.change(textarea, { target: { value: '안녕하세요' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    const msgs = useChatStore.getState().messages
    expect(msgs.some(m => m.role === 'user' && m.content === '안녕하세요')).toBe(true)
  })

  it('shows assistant message after delay', async () => {
    render(<ChatPanel />)
    const textarea = screen.getByTestId('chat-textarea')
    fireEvent.change(textarea, { target: { value: '테스트' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    // Advance timers past the mock response delay
    await act(async () => { vi.advanceTimersByTime(3000) })

    const msgs = useChatStore.getState().messages
    expect(msgs.some(m => m.role === 'assistant')).toBe(true)
  })
})

describe('QuickQuestions', () => {
  it('renders a single quick question button (random pick)', () => {
    render(<ChatPanel />)
    const buttons = screen.getAllByTestId(/^quick-q-/)
    expect(buttons.length).toBe(1)
  })

  it('clicking a quick question sends a message', async () => {
    render(<ChatPanel />)
    const firstQ = screen.getByTestId('quick-q-0')
    fireEvent.click(firstQ)
    const msgs = useChatStore.getState().messages
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs[0].role).toBe('user')
  })
})
