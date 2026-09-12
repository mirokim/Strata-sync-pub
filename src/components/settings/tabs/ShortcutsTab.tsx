// ── ShortcutsTab — keyboard shortcut reference ───────────────────────────────

interface ShortcutRow {
  keys: string[]
  desc: string
}

interface ShortcutGroup {
  label: string
  rows: ShortcutRow[]
}

const GROUPS: ShortcutGroup[] = [
  {
    label: '에디터',
    rows: [
      { keys: ['Ctrl', 'S'],           desc: '저장' },
      { keys: ['Ctrl', 'B'],           desc: '굵게 (Bold)' },
      { keys: ['Ctrl', 'I'],           desc: '기울임 (Italic)' },
      { keys: ['Ctrl', 'Shift', 'S'],  desc: '취소선 (Strikethrough)' },
      { keys: ['Ctrl', 'Shift', 'H'],  desc: '하이라이트 (Highlight)' },
      { keys: ['Ctrl', 'Shift', 'C'],  desc: '인라인 코드 (Inline Code)' },
      { keys: ['Ctrl', 'Z'],           desc: '실행 취소 (Undo)' },
      { keys: ['Ctrl', 'Y'],           desc: '다시 실행 (Redo)' },
      { keys: ['Ctrl', 'A'],           desc: '전체 선택' },
    ],
  },
  {
    label: '채팅',
    rows: [
      { keys: ['Enter'],              desc: '메시지 전송' },
      { keys: ['Shift', 'Enter'],     desc: '줄바꿈' },
    ],
  },
  {
    label: '그래프',
    rows: [
      { keys: ['Scroll'],             desc: '줌 인 / 아웃' },
      { keys: ['Drag'],               desc: '뷰 이동 (Pan)' },
      { keys: ['Click'],              desc: '노드 선택' },
      { keys: ['Double Click'],       desc: '노드 에디터로 열기' },
    ],
  },
  {
    label: '일반',
    rows: [
      { keys: ['Escape'],             desc: '팝업 / 메뉴 닫기' },
    ],
  },
]

function Kbd({ children }: { children: string }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: 4,
      fontSize: 10,
      fontFamily: 'var(--ea-font-mono)',
      background: 'var(--color-bg-active)',
      border: '1px solid var(--color-border)',
      color: 'var(--color-text-primary)',
      lineHeight: 1.8,
    }}>
      {children}
    </span>
  )
}

export default function ShortcutsTab() {
  const row: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '5px 0',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    gap: 12,
  }

  const sectionTitle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    marginBottom: 6,
  }

  return (
    <div className="flex flex-col gap-6">
      {GROUPS.map(group => (
        <div key={group.label}>
          <p style={sectionTitle}>{group.label}</p>
          {group.rows.map(({ keys, desc }) => (
            <div key={desc} style={row}>
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{desc}</span>
              <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexShrink: 0 }}>
                {keys.map((k, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    {i > 0 && <span style={{ fontSize: 9, color: 'var(--color-text-muted)', opacity: 0.5 }}>+</span>}
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
