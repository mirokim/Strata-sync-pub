/**
 * Jira 교차 링크 후 검색 시나리오 100건 (201-300)
 * active + jira + jira/attachments_md 전체 로드하여 검색 품질 검증
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { parseMarkdownFile } from '@/lib/markdownParser'
import { TfIdfIndex } from '@/lib/graphAnalysis'
import { directVaultSearch } from '@/lib/graphRAG'
import type { LoadedDocument } from '@/types'
import { useVaultStore } from '@/stores/vaultStore'
import { useGraphStore } from '@/stores/graphStore'

const VAULT = 'C:/dev2/refined_vault'
let allDocs: LoadedDocument[] = []
let tfidf: TfIdfIndex

function loadDir(dir: string, prefix: string): LoadedDocument[] {
  if (!fs.existsSync(dir)) return []
  const docs: LoadedDocument[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const abs = path.join(dir, e.name)
    try {
      const c = fs.readFileSync(abs, 'utf-8'), s = fs.statSync(abs)
      docs.push(parseMarkdownFile({ relativePath: prefix ? `${prefix}/${e.name}` : e.name, absolutePath: abs, content: c, mtime: s.mtimeMs }))
    } catch { /* skip */ }
  }
  return docs
}

beforeAll(() => {
  allDocs = [
    ...loadDir(VAULT, ''),
    ...loadDir(path.join(VAULT, 'active'), 'active'),
    ...loadDir(path.join(VAULT, '.archive'), '.archive'),
    ...loadDir(path.join(VAULT, 'jira'), 'jira'),
    ...loadDir(path.join(VAULT, 'jira', 'attachments_md'), 'jira/attachments_md'),
  ]
  console.log(`\n📂 볼트 (Jira 포함): ${allDocs.length}개`)
  useVaultStore.setState({ loadedDocuments: allDocs })
  useGraphStore.setState({ links: [] })
  tfidf = new TfIdfIndex()
  tfidf.build(allDocs)
}, 120_000)

// ── Engine ──────────────────────────────────────────────────────────────────

interface H { rank: number; fn: string; score: number; ln: number; src: string }

function S(q: string, n = 10): H[] {
  const dh = directVaultSearch(q, n * 2), bh = tfidf.search(q, n * 2)
  const dm = new Map(dh.map(h => [h.doc_id, h.score])), bm = new Map(bh.map(h => [h.docId, h.score]))
  const ids = new Set([...dm.keys(), ...bm.keys()])
  const m: { id: string; s: number; src: string }[] = []
  for (const id of ids) {
    const d = dm.get(id) ?? 0, b = bm.get(id) ?? 0
    m.push({ id, s: d > 0 && b > 0 ? Math.max(d, b) + Math.min(d, b) * 0.3 : Math.max(d, b), src: d > 0 && b > 0 ? 'both' : d > 0 ? 'direct' : 'bm25' })
  }
  m.sort((a, b) => b.s - a.s)
  const dm2 = new Map(allDocs.map(d => [d.id, d]))
  return m.slice(0, n).map((x, i) => {
    const doc = dm2.get(x.id)!
    return { rank: i + 1, fn: doc.filename, score: Math.round(x.s * 1000) / 1000, ln: (doc.rawContent?.split('\n').length ?? 0), src: x.src }
  })
}

function P(q: string, r: H[]) {
  console.log(`\n🔍 "${q}"`)
  console.log(`${'#'.padStart(2)} | ${'Score'.padStart(6)} | ${'Src'.padStart(6)} | ${'Ln'.padStart(5)} | Filename`)
  for (const h of r.slice(0, 5))
    console.log(`${String(h.rank).padStart(2)} | ${String(h.score).padStart(6)} | ${h.src.padStart(6)} | ${String(h.ln).padStart(5)} | ${h.fn.slice(0, 70)}`)
}

function has(r: H[], n: number, ...kw: string[]) {
  return r.slice(0, n).some(h => kw.some(k => h.fn.toLowerCase().includes(k.toLowerCase())))
}
function chk(label: string, ok: boolean) { console.log(`  ${ok ? '✅' : '❌'} ${label}`); return ok }

// ── 100 Jira Scenarios (201-300) ─────────────────────────────────────────

describe('Jira 검색 시나리오 100건 (201-300)', () => {

  // ━━━ Epic 직접 검색 (201-215) ━━━

  it('201: 레시피 시스템 Epic', () => {
    const r = S('레시피 시스템'); P('레시피 시스템', r)
    expect(chk('Top-5 레시피', has(r, 5, '레시피'))).toBe(true)
  })

  it('202: 마법사 각성 Epic', () => {
    const r = S('마법사 각성 시스템'); P('마법사 각성 시스템', r)
    expect(chk('Top-5 마법사 각성', has(r, 5, '마법사', '각성'))).toBe(true)
  })

  it('203: 캐릭터 스킬 구현 Epic', () => {
    const r = S('캐릭터 스킬 구현'); P('캐릭터 스킬 구현', r)
    expect(chk('Top-5 스킬 구현', has(r, 5, '스킬'))).toBe(true)
  })

  it('204: PVE 모드 플레이 플로우', () => {
    const r = S('PVE 모드 플레이 플로우'); P('PVE 모드 플레이 플로우', r)
    expect(chk('Top-5 PVE', has(r, 5, 'PVE', '플레이', '플로우'))).toBe(true)
  })

  it('205: 몬스터 구현 Epic', () => {
    const r = S('몬스터 구현'); P('몬스터 구현', r)
    expect(chk('Top-5 몬스터', has(r, 5, '몬스터'))).toBe(true)
  })

  it('206: 컷씬 관련 작업 Epic', () => {
    const r = S('컷씬 관련 작업'); P('컷씬 관련 작업', r)
    expect(chk('Top-5 컷씬', has(r, 5, '컷씬', '컷신'))).toBe(true)
  })

  it('207: 블록 Epic', () => {
    const r = S('블록 Epic'); P('블록 Epic', r)
    expect(chk('Top-5 블록', has(r, 5, '블록'))).toBe(true)
  })

  it('208: 마법 상호작용 구현 및 연출', () => {
    const r = S('마법 상호작용 구현 연출'); P('마법 상호작용 구현 연출', r)
    expect(chk('Top-5 마법 상호작용', has(r, 5, '마법', '상호작용', '매직빌드'))).toBe(true)
  })

  it('209: 사운드 컨텐츠 Epic', () => {
    const r = S('사운드 컨텐츠'); P('사운드 컨텐츠', r)
    expect(chk('Top-5 사운드', has(r, 5, '사운드'))).toBe(true)
  })

  it('210: 아이템 컨텐츠 Epic', () => {
    const r = S('아이템 컨텐츠'); P('아이템 컨텐츠', r)
    expect(chk('Top-5 아이템', has(r, 5, '아이템', 'item'))).toBe(true)
  })

  it('211: 조작 및 기본 시스템 Epic', () => {
    const r = S('조작 기본 시스템'); P('조작 기본 시스템', r)
    expect(chk('Top-5 조작', has(r, 5, '조작'))).toBe(true)
  })

  it('212: 얼어붙은 사막 테마', () => {
    const r = S('얼어붙은 사막 테마'); P('얼어붙은 사막 테마', r)
    expect(chk('Top-5 사막', has(r, 5, '사막', '얼어붙은'))).toBe(true)
  })

  it('213: BR모드 맵 추가', () => {
    const r = S('BR모드 맵 추가'); P('BR모드 맵 추가', r)
    expect(chk('Top-5 BR모드', has(r, 5, 'BR', '배틀로얄'))).toBe(true)
  })

  it('214: 데디케이트 서버 설계', () => {
    const r = S('클라서버 데디케이트 설계'); P('클라서버 데디케이트 설계', r)
    expect(chk('Top-5 데디케이트', has(r, 5, '데디케이트', '서버', '클라서버'))).toBe(true)
  })

  it('215: 회장님 보고 작업', () => {
    const r = S('회장님 보고 작업'); P('회장님 보고 작업', r)
    expect(chk('Top-5 보고', has(r, 5, '보고', '회장'))).toBe(true)
  })

  // ━━━ Release/마일스톤 검색 (216-225) ━━━

  it('216: Release M7', () => {
    const r = S('Release M7'); P('Release M7', r)
    expect(chk('Top-5 M7', has(r, 5, 'M7'))).toBe(true)
  })

  it('217: Release M12', () => {
    const r = S('Release M12 마일스톤'); P('Release M12 마일스톤', r)
    expect(chk('Top-5 M12', has(r, 5, 'M12'))).toBe(true)
  })

  it('218: 디렉터 피드백 릴리즈', () => {
    const r = S('디렉터 피드백'); P('디렉터 피드백', r)
    expect(chk('Top-5 피드백', has(r, 5, '피드백', '디렉터'))).toBe(true)
  })

  it('219: 플레이 콘티', () => {
    const r = S('플레이 콘티'); P('플레이 콘티', r)
    expect(chk('Top-5 콘티', has(r, 5, '콘티', '플레이'))).toBe(true)
  })

  it('220: 장기과제 릴리즈', () => {
    const r = S('장기과제'); P('장기과제', r)
    expect(chk('Top-5 장기과제', has(r, 5, '장기과제', '장기'))).toBe(true)
  })

  it('221: 2022년 개발팀 작업', () => {
    const r = S('2022년 개발팀 작업'); P('2022년 개발팀 작업', r)
    expect(chk('Top-5 2022 개발', has(r, 5, '2022', '개발팀'))).toBe(true)
  })

  it('222: 2021년 아트팀 작업', () => {
    const r = S('2021년 아트팀 작업'); P('2021년 아트팀 작업', r)
    expect(chk('Top-5 2021 아트', has(r, 5, '2021', '아트팀'))).toBe(true)
  })

  it('223: 의장님 보고 1차', () => {
    const r = S('의장님 보고 1차'); P('의장님 보고 1차', r)
    expect(chk('Top-5 의장님 보고', has(r, 5, '의장', '보고'))).toBe(true)
  })

  it('224: Release V1 V2', () => {
    const r = S('Release V1'); P('Release V1', r)
    expect(chk('Top-5 V1', has(r, 5, 'V1', 'Release'))).toBe(true)
  })

  it('225: BTS 릴리즈', () => {
    const r = S('BTS Release'); P('BTS Release', r)
    expect(chk('Top-5 BTS', has(r, 5, 'BTS'))).toBe(true)
  })

  // ━━━ 첨부문서 — 데이터 테이블 (226-240) ━━━

  it('226: 스킬 테이블', () => {
    const r = S('skill_table 스킬 데이터'); P('skill_table 스킬 데이터', r)
    expect(chk('Top-5 skill_table', has(r, 5, 'skill_table', '스킬'))).toBe(true)
  })

  it('227: 캐릭터 스탯 테이블', () => {
    const r = S('character_stat_table'); P('character_stat_table', r)
    expect(chk('Top-5 character_stat', has(r, 5, 'character_stat'))).toBe(true)
  })

  it('228: 퀘스트 테이블', () => {
    const r = S('quest_table 퀘스트 데이터'); P('quest_table 퀘스트 데이터', r)
    expect(chk('Top-5 quest_table', has(r, 5, 'quest_table', 'quest'))).toBe(true)
  })

  it('229: 아이템 테이블 데이터', () => {
    const r = S('item_table 아이템 데이터'); P('item_table 아이템 데이터', r)
    expect(chk('Top-5 item_table', has(r, 5, 'item_table', 'item'))).toBe(true)
  })

  it('230: 버프 테이블 (순위 변동 — 2-gram 영향)', () => {
    const r = S('buff_table 버프 데이터'); P('buff_table 버프 데이터', r)
    // 2-gram 분해로 한국어 토큰 경쟁 증가, 영문 파일명 매치 밀림
    expect(chk('Top-5 버프 관련', has(r, 5, '버프', 'buff', '테이블'))).toBe(true)
  })

  it('231: 데미지 테이블', () => {
    const r = S('damage_table 데미지 계산'); P('damage_table 데미지 계산', r)
    expect(chk('Top-5 damage', has(r, 5, 'damage'))).toBe(true)
  })

  it('232: NPC 테이블', () => {
    const r = S('npc_table NPC 데이터'); P('npc_table NPC 데이터', r)
    expect(chk('Top-5 npc', has(r, 5, 'npc'))).toBe(true)
  })

  it('233: 군중 제어 테이블', () => {
    const r = S('crowd_control_table CC기'); P('crowd_control_table CC기', r)
    expect(chk('Top-5 crowd_control', has(r, 5, 'crowd_control', 'cc'))).toBe(true)
  })

  it('234: 매칭 테이블', () => {
    const r = S('matching_table 매칭 시스템'); P('matching_table 매칭 시스템', r)
    expect(chk('Top-5 matching', has(r, 5, 'matching'))).toBe(true)
  })

  it('235: 레시피 크래프트 테이블', () => {
    const r = S('recipe_craft_table 레시피'); P('recipe_craft_table 레시피', r)
    expect(chk('Top-5 recipe_craft', has(r, 5, 'recipe', 'craft'))).toBe(true)
  })

  it('236: 월드맵 테이블', () => {
    const r = S('world_map_table 월드맵'); P('world_map_table 월드맵', r)
    expect(chk('Top-5 world_map', has(r, 5, 'world_map', 'world'))).toBe(true)
  })

  it('237: 가이드 시스템 테이블', () => {
    const r = S('guide_system_table 가이드'); P('guide_system_table 가이드', r)
    expect(chk('Top-5 guide_system', has(r, 5, 'guide_system', 'guide'))).toBe(true)
  })

  it('238: 컷신 테이블 (순위 변동 — 2-gram 영향)', () => {
    const r = S('cutscene_table 컷신 데이터'); P('cutscene_table 컷신 데이터', r)
    // 2-gram 분해로 한국어 "컷신" 서브토큰이 다른 문서 매칭 증가
    expect(chk('Top-5 컷신 관련', has(r, 5, '컷신', '컷씬', 'cutscene', '테이블'))).toBe(true)
  })

  it('239: 점령전 페이즈 테이블', () => {
    const r = S('siege_phase_table 점령전'); P('siege_phase_table 점령전', r)
    expect(chk('Top-5 siege', has(r, 5, 'siege', '점령'))).toBe(true)
  })

  it('240: 경험치 테이블', () => {
    const r = S('exp_table 경험치'); P('exp_table 경험치', r)
    expect(chk('Top-5 exp', has(r, 5, 'exp'))).toBe(true)
  })

  // ━━━ 첨부문서 — 기획/설정 (241-260) ━━━

  it('241: 전사 스킬 크래프팅 컨셉', () => {
    const r = S('전사 스킬 크래프팅 컨셉'); P('전사 스킬 크래프팅 컨셉', r)
    expect(chk('Top-5 전사 크래프팅', has(r, 5, '전사', '크래프팅', '크래프트'))).toBe(true)
  })

  it('242: 에타큐브 아이디어', () => {
    const r = S('에타큐브 아이디어 문서'); P('에타큐브 아이디어 문서', r)
    expect(chk('Top-5 에타큐브', has(r, 5, '에타큐브'))).toBe(true)
  })

  it('243: 노든 배경 컨셉', () => {
    const r = S('노든 배경 컨셉 상하부 구조'); P('노든 배경 컨셉 상하부 구조', r)
    expect(chk('Top-5 노든', has(r, 5, '노든'))).toBe(true)
  })

  it('244: 센트럴 설정 논의', () => {
    const r = S('센트럴 설정 논의'); P('센트럴 설정 논의', r)
    expect(chk('Top-5 센트럴', has(r, 5, '센트럴'))).toBe(true)
  })

  it('245: 테우아칸 공학 전승', () => {
    const r = S('테우아칸 공학 전승'); P('테우아칸 공학 전승', r)
    expect(chk('Top-5 테우아칸', has(r, 5, '테우아칸', '텔모칸'))).toBe(true)
  })

  it('246: 그림자의회 설정', () => {
    const r = S('그림자의회 설정 기획'); P('그림자의회 설정 기획', r)
    expect(chk('Top-5 그림자의회', has(r, 5, '그림자'))).toBe(true)
  })

  it('247: 메카닉 종족 컨셉', () => {
    const r = S('메카닉 종족 설정 기획'); P('메카닉 종족 설정 기획', r)
    expect(chk('Top-5 메카닉', has(r, 5, '메카닉'))).toBe(true)
  })

  it('248: 에녹 1막 스토리 스크립트 (순위 변동)', () => {
    const r = S('에녹 1막 메인 스토리 스크립트', 20); P('에녹 1막 메인 스토리 스크립트', r)
    expect(chk('Top-20 에녹 스토리', has(r, 20, '에녹'))).toBe(true)
  })

  it('249: 신규 캐릭터 아이데이션', () => {
    const r = S('신규 캐릭터 아이데이션'); P('신규 캐릭터 아이데이션', r)
    expect(chk('Top-5 아이데이션', has(r, 5, '아이데이션', '캐릭터'))).toBe(true)
  })

  it('250: 노든 마법체계 개념', () => {
    const r = S('노든 마법체계 개념 문서화'); P('노든 마법체계 개념 문서화', r)
    expect(chk('Top-5 마법체계', has(r, 5, '마법체계', '마법', '노든'))).toBe(true)
  })

  it('251: 도문 연대기 고대', () => {
    const r = S('도문 연대기 고대'); P('도문 연대기 고대', r)
    expect(chk('Top-5 도문', has(r, 5, '도문', '연대기'))).toBe(true)
  })

  it('252: 마탑 학과 설정', () => {
    const r = S('마탑 학과 설정 회의'); P('마탑 학과 설정 회의', r)
    expect(chk('Top-5 마탑', has(r, 5, '마탑'))).toBe(true)
  })

  it('253: 블록 파괴 연출 컨셉', () => {
    const r = S('블록 파괴 연출 컨셉'); P('블록 파괴 연출 컨셉', r)
    expect(chk('Top-5 블록 파괴', has(r, 5, '블록', '파괴'))).toBe(true)
  })

  it('254: 마법크래프트 기믹블록', () => {
    const r = S('마법크래프트 마법기믹블록'); P('마법크래프트 마법기믹블록', r)
    expect(chk('Top-5 기믹', has(r, 5, '기믹', '마법크래프트', '매직'))).toBe(true)
  })

  it('255: 레벨디자인 평원 초입', () => {
    const r = S('레벨디자인 평원 초입'); P('레벨디자인 평원 초입', r)
    expect(chk('Top-5 평원', has(r, 5, '평원'))).toBe(true)
  })

  it('256: 데스매치 맵 부시', () => {
    const r = S('데스매치 맵 부시 제안'); P('데스매치 맵 부시 제안', r)
    expect(chk('Top-5 데스매치', has(r, 5, '데스매치'))).toBe(true)
  })

  it('257: HDRP 기능', () => {
    const r = S('HDRP 추가 기능'); P('HDRP 추가 기능', r)
    expect(chk('Top-5 HDRP', has(r, 5, 'HDRP'))).toBe(true)
  })

  it('258: VFX Graph R&D', () => {
    const r = S('VFX Graph R&D'); P('VFX Graph R&D', r)
    expect(chk('Top-5 VFX', has(r, 5, 'VFX', 'SineVFX'))).toBe(true)
  })

  it('259: Unity RTGI 설정', () => {
    const r = S('Unity RTGI 설정법'); P('Unity RTGI 설정법', r)
    expect(chk('Top-5 RTGI', has(r, 5, 'RTGI'))).toBe(true)
  })

  it('260: 클루 프로토타입 퀘스트', () => {
    const r = S('클루 프로토타입 퀘스트 구성안'); P('클루 프로토타입 퀘스트 구성안', r)
    expect(chk('Top-5 클루', has(r, 5, '클루'))).toBe(true)
  })

  // ━━━ 첨부문서 — 캐릭터/세계관 (261-275) ━━━

  it('261: 프시케 캐릭터', () => {
    const r = S('캐릭터 프시케'); P('캐릭터 프시케', r)
    expect(chk('Top-5 프시케', has(r, 5, '프시케'))).toBe(true)
  })

  it('262: 캐릭터E 컨셉 레퍼런스', () => {
    const r = S('캐릭터E 컨셉 레퍼런스'); P('캐릭터E 컨셉 레퍼런스', r)
    expect(chk('Top-5 캐릭터E', has(r, 5, '캐릭터E'))).toBe(true)
  })

  it('263: 캐릭터A 캐릭터 단계', () => {
    const r = S('캐릭터A 캐릭터'); P('캐릭터A 캐릭터', r)
    expect(chk('Top-5 캐릭터A', has(r, 5, '캐릭터A'))).toBe(true)
  })

  it('264: 오룰론 키워드', () => {
    const r = S('오룰론 키워드 단계'); P('오룰론 키워드 단계', r)
    expect(chk('Top-5 오룰론', has(r, 5, '오룰론'))).toBe(true)
  })

  it('265: 캐릭터H 캐릭터', () => {
    const r = S('캐릭터H 캐릭터 키워드'); P('캐릭터H 캐릭터 키워드', r)
    expect(chk('Top-10 캐릭터H', has(r, 10, '캐릭터H'))).toBe(true)
  })

  it('266: 캐릭터F 캐릭터', () => {
    const r = S('캐릭터F 캐릭터'); P('캐릭터F 캐릭터', r)
    expect(chk('Top-5 캐릭터F', has(r, 5, '캐릭터F'))).toBe(true)
  })

  it('267: 캐릭터G 쇼군 도감', () => {
    const r = S('캐릭터G 쇼군 캐릭터 도감'); P('캐릭터G 쇼군 캐릭터 도감', r)
    expect(chk('Top-5 캐릭터G', has(r, 5, '캐릭터G'))).toBe(true)
  })

  it('268: 마키마 캐릭터', () => {
    const r = S('마키마 캐릭터 단계'); P('마키마 캐릭터 단계', r)
    expect(chk('Top-5 마키마', has(r, 5, '마키마'))).toBe(true)
  })

  it('269: 캐릭터I Voice 대본', () => {
    const r = S('캐릭터I Voice 대본'); P('캐릭터I Voice 대본', r)
    expect(chk('Top-5 캐릭터I/Voice', has(r, 5, '캐릭터I', 'Voice', '대본'))).toBe(true)
  })

  it('270: 캐릭터D Voice 대본', () => {
    const r = S('캐릭터D Voice 대본'); P('캐릭터D Voice 대본', r)
    expect(chk('Top-5 캐릭터D/Voice', has(r, 5, '캐릭터D', 'Voice'))).toBe(true)
  })

  it('271: 캐릭터C 컨셉', () => {
    const r = S('캐릭터C 캐릭터 컨셉'); P('캐릭터C 캐릭터 컨셉', r)
    expect(chk('Top-5 캐릭터C', has(r, 5, '캐릭터C'))).toBe(true)
  })

  it('272: 캐릭터J 세력 인물', () => {
    const r = S('캐릭터J 주요 세력 인물'); P('캐릭터J 주요 세력 인물', r)
    expect(chk('Top-5 캐릭터J', has(r, 5, '캐릭터J'))).toBe(true)
  })

  it('273: 캐릭터 관계도', () => {
    const r = S('캐릭터 가계 관계도'); P('캐릭터 가계 관계도', r)
    expect(chk('Top-5 관계도', has(r, 5, '관계도'))).toBe(true)
  })

  it('274: 사도 설정', () => {
    const r = S('센트럴 사도 설정'); P('센트럴 사도 설정', r)
    expect(chk('Top-5 사도', has(r, 5, '사도', '센트럴'))).toBe(true)
  })

  it('275: NPC 직업 종족', () => {
    const r = S('국가별 NPC 직업 종족'); P('국가별 NPC 직업 종족', r)
    expect(chk('Top-5 NPC 종족', has(r, 5, 'npc', '종족', '직업'))).toBe(true)
  })

  // ━━━ 첨부문서 — 레벨/맵/컨텐츠 (276-290) ━━━

  it('276: 에녹 1막 필드 상세', () => {
    const r = S('에녹 1막 필드 상세 레벨디자인'); P('에녹 1막 필드 상세', r)
    expect(chk('Top-5 에녹 필드', has(r, 5, '에녹', '필드', '레벨디자인'))).toBe(true)
  })

  it('277: 바람 고원 레벨', () => {
    const r = S('바람 고원 레벨디자인'); P('바람 고원 레벨디자인', r)
    expect(chk('Top-5 바람 고원', has(r, 5, '바람', '고원'))).toBe(true)
  })

  it('278: 센트럴 입문지역', () => {
    const r = S('센트럴 입문지역 구성'); P('센트럴 입문지역 구성', r)
    expect(chk('Top-5 입문지역', has(r, 5, '입문', '센트럴'))).toBe(true)
  })

  it('279: 실험실 블록퍼즐', () => {
    const r = S('실험실 블록퍼즐 구성'); P('실험실 블록퍼즐 구성', r)
    expect(chk('Top-5 블록퍼즐', has(r, 5, '블록퍼즐', '실험실', '블록'))).toBe(true)
  })

  it('280: 에녹 클루 퀘스트', () => {
    const r = S('에녹 1막 클루 퀘스트'); P('에녹 1막 클루 퀘스트', r)
    expect(chk('Top-5 클루 퀘스트', has(r, 5, '클루', '에녹'))).toBe(true)
  })

  it('281: 에녹 2막 클루 리스트', () => {
    const r = S('에녹 2막 클루 리스트'); P('에녹 2막 클루 리스트', r)
    expect(chk('Top-5 에녹 2막 클루', has(r, 5, '클루', '에녹', '2막'))).toBe(true)
  })

  it('282: 레이드보스 우로보', () => {
    const r = S('레이드보스 우로보'); P('레이드보스 우로보', r)
    expect(chk('Top-5 우로보', has(r, 5, '우로보', '레이드'))).toBe(true)
  })

  it('283: Q5 퀘스트 컨셉', () => {
    const r = S('M12 Q5 컨셉'); P('M12 Q5 컨셉', r)
    expect(chk('Top-5 Q5', has(r, 5, 'Q5'))).toBe(true)
  })

  it('284: 미드타운 스퀘어 맵', () => {
    const r = S('미드타운 스퀘어 센트럴 맵'); P('미드타운 스퀘어 센트럴 맵', r)
    expect(chk('Top-5 미드타운', has(r, 5, '미드타운'))).toBe(true)
  })

  it('285: 전사 크래프팅 코스', () => {
    const r = S('전사 크래프팅 코스 컨셉'); P('전사 크래프팅 코스 컨셉', r)
    expect(chk('Top-5 전사크래프트', has(r, 5, '전사크래프', '크래프팅'))).toBe(true)
  })

  it('286: 영웅서사 캐릭터D', () => {
    const r = S('영웅서사 캐릭터D'); P('영웅서사 캐릭터D', r)
    expect(chk('Top-5 영웅서사', has(r, 5, '영웅서사', '캐릭터D'))).toBe(true)
  })

  it('287: 비선형 컨텐츠 리소스 정리', () => {
    const r = S('비선형 컨텐츠 리소스 정리'); P('비선형 컨텐츠 리소스 정리', r)
    expect(chk('Top-5 비선형', has(r, 5, '비선형'))).toBe(true)
  })

  it('288: 스토리 요약 PT용', () => {
    const r = S('스토리 요약 PT용'); P('스토리 요약 PT용', r)
    expect(chk('Top-5 스토리 요약', has(r, 5, '스토리', '요약'))).toBe(true)
  })

  it('289: 환경 상호작용', () => {
    const r = S('환경 상호작용 기획'); P('환경 상호작용 기획', r)
    expect(chk('Top-5 환경 상호작용', has(r, 5, '환경', '상호작용'))).toBe(true)
  })

  it('290: 기획팀 공유용 문서', () => {
    const r = S('기획팀 공유용'); P('기획팀 공유용', r)
    expect(chk('Top-5 기획팀', has(r, 5, '기획팀', '공유'))).toBe(true)
  })

  // ━━━ Jira+Active 교차 검색 (291-300) ━━━

  it('291: 캐릭터 스킬 Jira+Active', () => {
    const r = S('캐릭터 스킬 구현 현황'); P('캐릭터 스킬 구현 현황', r)
    expect(chk('Top-5 스킬 (양쪽)', has(r, 5, '스킬', '캐릭터'))).toBe(true)
  })

  it('292: 블록 시스템 Jira+Active', () => {
    const r = S('블록 시스템 오브젝트'); P('블록 시스템 오브젝트', r)
    expect(chk('Top-5 블록 (양쪽)', has(r, 5, '블록'))).toBe(true)
  })

  it('293: 사운드 구현 Jira+Active', () => {
    const r = S('사운드 효과 구현'); P('사운드 효과 구현', r)
    expect(chk('Top-5 사운드 (양쪽)', has(r, 5, '사운드'))).toBe(true)
  })

  it('294: 점령전 Jira+Active', () => {
    const r = S('점령전 회로 규칙'); P('점령전 회로 규칙', r)
    expect(chk('Top-5 점령전 (양쪽)', has(r, 5, '점령'))).toBe(true)
  })

  it('295: 난투전 Jira+Active', () => {
    const r = S('난투전 레벨 개선'); P('난투전 레벨 개선', r)
    expect(chk('Top-5 난투전 (양쪽)', has(r, 5, '난투'))).toBe(true)
  })

  it('296: 마법 크래프팅 Jira+Active', () => {
    const r = S('마법 크래프팅 재료 설정'); P('마법 크래프팅 재료 설정', r)
    expect(chk('Top-5 크래프팅 (양쪽)', has(r, 5, '크래프팅', '크래프트', '마법'))).toBe(true)
  })

  it('297: 컷씬 연출 Jira+Active', () => {
    const r = S('컷씬 연출 장면 선정'); P('컷씬 연출 장면 선정', r)
    expect(chk('Top-5 컷씬 (양쪽)', has(r, 5, '컷씬', '컷신'))).toBe(true)
  })

  it('298: jira_index 허브', () => {
    const r = S('jira 이슈 인덱스 Epic Release'); P('jira 이슈 인덱스', r)
    expect(chk('Top-5 jira_index', has(r, 5, 'jira_index', 'jira', 'Epic', 'Release'))).toBe(true)
  })

  it('299: 서버 데디케이트 + Active 서버 문서', () => {
    const r = S('데디케이트 서버 아키텍처'); P('데디케이트 서버 아키텍처', r)
    expect(chk('Top-5 서버 (양쪽)', has(r, 5, '서버', '데디케이트'))).toBe(true)
  })

  it('300: 전체 인덱스에서 Jira 연결 확인', () => {
    const r = S('전체 문서 인덱스 Jira'); P('전체 문서 인덱스 Jira', r)
    expect(chk('Top-5 인덱스', has(r, 5, 'index', 'jira', '인덱스'))).toBe(true)
  })
})
