import { useRef } from 'react'
import { Upload } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { fieldInputStyle, fieldLabelStyle } from '../settingsShared'

const uploadBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10,
  padding: '2px 7px',
  borderRadius: 4,
  border: '1px solid var(--color-border)',
  background: 'transparent',
  color: 'var(--color-text-muted)',
  cursor: 'pointer',
  transition: 'color 0.1s',
}

export default function ProjectTab() {
  const { projectInfo, setProjectInfo } = useSettingsStore()
  const projectFileRef = useRef<HTMLInputElement>(null)
  const teamFileRef = useRef<HTMLInputElement>(null)

  function handleProjectFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      setProjectInfo({ rawProjectInfo: (ev.target?.result as string).trim() })
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  function handleTeamFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      setProjectInfo({ teamMembers: (ev.target?.result as string).trim() })
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>프로젝트 정보</h3>
          <button style={uploadBtnStyle} onClick={() => projectFileRef.current?.click()} title="프로젝트 .md 파일에서 불러오기">
            <Upload size={10} /> MD 불러오기
          </button>
          <input ref={projectFileRef} type="file" accept=".md" style={{ display: 'none' }} onChange={handleProjectFile} />
        </div>
        <textarea
          value={projectInfo.rawProjectInfo}
          onChange={e => setProjectInfo({ rawProjectInfo: e.target.value })}
          placeholder={'# 프로젝트명\n\n게임 엔진, 장르, 플랫폼, 팀 규모, 개요 등\nMD 파일 내용을 그대로 붙여넣으세요.'}
          rows={10}
          style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.6 }}
        />
      </section>

      {/* 현재 상황 */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <label style={{ ...fieldLabelStyle, marginBottom: 0 }}>현재 상황</label>
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>볼트 데이터와 다른 최신 현실 정보 · MD 형식 지원</span>
        </div>
        <textarea
          value={projectInfo.currentSituation}
          onChange={e => setProjectInfo({ currentSituation: e.target.value })}
          placeholder={'## 현재 스프린트\n- 알파 테스트 진행 중 (2주 남음)\n- 전투 시스템 우선순위\n\n## 최근 결정사항\n- ...'}
          rows={7}
          style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.6 }}
        />
      </section>

      {/* 팀원 */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <label style={{ ...fieldLabelStyle, marginBottom: 0 }}>팀원</label>
          <button style={uploadBtnStyle} onClick={() => teamFileRef.current?.click()} title="팀원 .md 파일에서 불러오기">
            <Upload size={10} /> MD 불러오기
          </button>
          <input ref={teamFileRef} type="file" accept=".md" style={{ display: 'none' }} onChange={handleTeamFile} />
        </div>
        <textarea
          value={projectInfo.teamMembers}
          onChange={e => setProjectInfo({ teamMembers: e.target.value })}
          placeholder={'chief: 홍길동\nart: 이순신, 박민수\nplan: 김철수\nprog: 이영희'}
          rows={4}
          style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.6 }}
        />
      </section>
    </div>
  )
}
