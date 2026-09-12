/**
 * RightPanel — the chat panel. (The Edit Agent side panel was retired from the GUI; agents
 * now work through MCP and the `_agent/` proposal flow.)
 */
import ChatPanel from '@/components/chat/ChatPanel'

export default function RightPanel() {
  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', position: 'relative' }}>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <ChatPanel />
      </div>
    </div>
  )
}
