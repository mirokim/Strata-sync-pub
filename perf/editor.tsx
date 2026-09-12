/**
 * Editor harness — mounts MarkdownEditor alone on a sample document, no vault or server.
 *
 *   npx vite --port 4189   then open  http://localhost:4189/perf/editor.html
 *
 * Saves fail (there is no vault API), which is fine for looking at rendering. `?lang=ko` sets the UI language.
 */
import { Buffer } from 'buffer'
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer

import ReactDOM from 'react-dom/client'
import MarkdownEditor from '@/components/editor/MarkdownEditor'
import { parseMarkdownFile } from '@/lib/markdownParser'
import { useVaultStore } from '@/stores/vaultStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import '@/index.css'

const SAMPLE = `---
title: "DR-0021 메인 브러시 두께 42mm로 변경"
type: decision
status: 채택
date: 2024-07-15
tags: [decision, mech, s1]
authors:
  - 박서현
  - 김민준
fake: true
---

# DR-0021 메인 브러시 두께 42mm로 변경

**상태:** 채택 · **대상:** [[온다 S1]] · **작성:** [[박서현]] (기구설계) #결정 #s1

## 배경
[[메인 브러시 (러버 롤)]]과 [[가구 아래 진입]]은 *반려동물 가구* 대응 관점에서 같이 봐야 한다. 신태호의 의견: "실측치가 표기값과 너무 다르다." 자세한 수치는 [소음 측정 기준](https://example.com/noise)을 참고. ~~이전 안은 폐기~~ ==핵심 문장==.

> [!warning] 금형 수정 리스크
> 코어 수정이 필요하면 4주 지연. \`DFM\` 검토 먼저.

## 대안
1. **규격 상향** — 장점: 금형 수정 없이 가능. 단점: 원가 상승.
2. **펌웨어로 보정** — 장점: 빠름.
   - 세부: \`motor_gain\` 파라미터만 변경
   - 세부: 테스트 2회차 필요

## 근거
| 항목 | 값 | 비고 |
|------|---:|:----:|
| 맵핑 완료 시간 | 189 | 검토 중 |
| 재청소율 | 36 | 확정 |

## 후속
- [ ] 박서현 → 릴리스 노트 반영
- [x] 검증: [[TR-0001 S1 카펫 청소 시험 1차]]
- [ ] 참고: [[양산 일정표]]

---

\`\`\`ts
const gain = clamp(base * 1.42, 0, 255)
\`\`\`

%% 내부 메모: 다음 리뷰 때 다시 %%
`

const q = new URLSearchParams(location.search)
document.documentElement.setAttribute('data-theme', q.get('theme') ?? 'dark')
if (q.get('lang')) useSettingsStore.setState({ language: q.get('lang') as 'ko' | 'en' })
const doc = parseMarkdownFile({ relativePath: '결정 기록/기구설계/DR-0021.md', content: SAMPLE } as Parameters<typeof parseMarkdownFile>[0])
useVaultStore.setState({ loadedDocuments: [doc], vaultPath: 'harness' })
useUIStore.setState({ editingDocId: doc.id, centerTab: 'editor' })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><MarkdownEditor /></div>,
)
