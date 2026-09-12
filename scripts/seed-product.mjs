#!/usr/bin/env node
/**
 * Seed a Strata Sync vault with a FAKE product-development vault: a Korean robot-vacuum start-up
 * ("온다 로보틱스") building three product generations (S1 → S2 → S3) over 2024-06 … 2026-09.
 *
 * Everything is invented from templates — people, suppliers, numbers, decisions — but the document
 * kinds and the way they cite each other mirror a real hardware/software team vault:
 *
 *   결정 기록 (DR-0001 …)   배경 → 대안 → 결정 → 후속. Some are later 폐기 and replaced, yet still cited.
 *   기능 / 부품 / ECR          feature ↔ component ↔ change-request links
 *   회의록                     weekly per team + gate reviews, citing decisions, issues, people
 *   이슈 (ISS-0001 …)          field/lab defects with cause analysis and the fix (DR/ECR/펌웨어)
 *   테스트 리포트 (TR-0001 …)  measurements per generation and round
 *   사용자 리서치              interviews, weekly VOC, surveys, review analyses, personas
 *   경쟁사 / 공급사 / 규제     comparisons, quotes, audits, certification progress
 *   릴리스 노트 / 로드맵       firmware + app releases, phase gates, monthly roadmap updates
 *   사람 / 팀 / 용어집 / 프로세스
 *
 * Deliberate graph defects for the linter: a handful of phantom links cited from many places
 * (e.g. [[S2 BOM 스프레드시트]]), superseded decisions still used as hubs, a few orphan memos.
 *
 *   node scripts/seed-product.mjs --out ./seed-vault                       # write to a folder
 *   node scripts/seed-product.mjs --server https://<worker> --token <team token> [--out …]
 *   node scripts/seed-product.mjs --server … --token … --wipe             # delete decisions/ worlds/ analysis/ wiki/ + own folders first
 *   node scripts/seed-product.mjs --scale 0.5                              # roughly half the documents
 *
 * Deterministic: the same --scale always produces the same documents (mulberry32 PRNG).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true'])
  return acc
}, []))
const OUT = args.out
const SERVER = args.server?.replace(/\/+$/, '')
const TOKEN = args.token ?? process.env.STRATA_TEAM_TOKEN
const WIPE = args.wipe === 'true'
const AUTHOR = args.author ?? 'seed'
const SCALE = Number(args.scale ?? 1)
const WIPE_PREFIXES = ['decisions/', 'worlds/', 'analysis/', 'wiki/', '온다/']
if (!OUT && !SERVER) { console.error('usage: seed-product.mjs --out <dir> | --server <url> --token <token> [--wipe] [--scale 1]'); process.exit(2) }
if (SERVER && !TOKEN) { console.error('--server needs --token (or STRATA_TEAM_TOKEN)'); process.exit(2) }

// ── PRNG + helpers ───────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 } return h }
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]
const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))
const chance = (rng, p) => rng() < p
const sample = (rng, arr, n) => { const a = [...arr]; const out = []; while (a.length && out.length < n) out.push(a.splice(Math.floor(rng() * a.length), 1)[0]); return out }
const scaled = n => Math.max(1, Math.round(n * SCALE))

// 한국어 조사: 받침 유무로 은/는, 이/가, 을/를, 과/와, 으로/로 선택
function hasBatchim(word) {
  const s = word.replace(/[\])\s"'”’]+$/g, '')
  const ch = s.charCodeAt(s.length - 1)
  if (ch >= 0xAC00 && ch <= 0xD7A3) return (ch - 0xAC00) % 28 !== 0
  if (/[0-9]$/.test(s)) return /[0136789]$/.test(s)          // 영·일·삼·육·칠·팔·구 → 받침 (0 = 영)
  if (/[A-Za-z]$/.test(s)) return /[lmnrLMNR]$/.test(s)        // 대충: L/M/N/R 로 끝나면 받침 취급
  return false
}
const JOSA = { '은/는': ['은', '는'], '이/가': ['이', '가'], '을/를': ['을', '를'], '과/와': ['과', '와'], '으로/로': ['으로', '로'], '아/야': ['아', '야'] }
function josa(word, pair) {
  const [b, nb] = JOSA[pair]
  if (pair === '으로/로') { // ㄹ 받침은 '로'
    const s = word.replace(/[\])\s]+$/g, ''); const ch = s.charCodeAt(s.length - 1)
    if (ch >= 0xAC00 && ch <= 0xD7A3 && (ch - 0xAC00) % 28 === 8) return word + '로'
  }
  return word + (hasBatchim(word) ? b : nb)
}
const L = name => `[[${name}]]`
const LJ = (name, pair) => josa(L(name), pair)

// 날짜
const DAY = 86400000
const D0 = Date.UTC(2024, 5, 3)             // 2024-06-03 (월) 회사 볼트 시작
const D1 = Date.UTC(2026, 8, 11)            // 2026-09-11 오늘
const fmt = t => new Date(t).toISOString().slice(0, 10)
const month = t => fmt(t).slice(0, 7)
const weeks = Math.floor((D1 - D0) / (7 * DAY))
const randDate = (rng, from = D0, to = D1) => from + Math.floor(rng() * ((to - from) / DAY)) * DAY
const clampDate = t => Math.min(Math.max(t, D0), D1)

// ── Company data (all invented) ──────────────────────────────────────────────

const CO = '온다 로보틱스'
const GENS = [
  { id: 'S1', name: '온다 S1', start: Date.UTC(2024, 5, 3), launch: Date.UTC(2025, 4, 20), end: D1, price: 549000, tagline: '첫 제품 — 흡입+물걸레 기본기' },
  { id: 'S2', name: '온다 S2', start: Date.UTC(2025, 0, 6), launch: Date.UTC(2026, 0, 27), end: D1, price: 899000, tagline: '자동 비움 스테이션과 반려동물 대응' },
  { id: 'S3', name: '온다 S3', start: Date.UTC(2025, 8, 1), launch: null, end: D1, price: 1290000, tagline: '올인원 스테이션, 카메라 기반 장애물 인식 (개발 중)' },
]
const PHASES = ['기획', 'EVT', 'DVT', 'PVT', '양산', '출시']
const genPhaseDates = g => {
  const span = (g.launch ?? D1) - g.start
  return PHASES.map((p, i) => ({ phase: p, date: g.start + Math.floor(span * (i / (PHASES.length - 1))) }))
}
const activeGens = t => GENS.filter(g => t >= g.start && t <= g.end)
const genFor = (rng, t) => { const a = activeGens(t); return a.length ? pick(rng, a) : GENS[0] }

const TEAMS = [
  { id: 'pm', name: '제품기획', speaker: 'product_manager' },
  { id: 'mech', name: '기구설계', speaker: 'mechanical_engineer' },
  { id: 'hw', name: '전장', speaker: 'hardware_engineer' },
  { id: 'fw', name: '펌웨어', speaker: 'firmware_engineer' },
  { id: 'nav', name: '내비게이션', speaker: 'navigation_engineer' },
  { id: 'app', name: '앱', speaker: 'app_developer' },
  { id: 'cloud', name: '클라우드', speaker: 'cloud_engineer' },
  { id: 'qa', name: '품질', speaker: 'qa_engineer' },
  { id: 'ux', name: '사용자리서치', speaker: 'ux_researcher' },
  { id: 'design', name: '디자인', speaker: 'designer' },
  { id: 'scm', name: '구매공급망', speaker: 'sourcing_manager' },
  { id: 'cert', name: '인증규제', speaker: 'compliance_manager' },
  { id: 'mfg', name: '제조', speaker: 'manufacturing_engineer' },
  { id: 'cs', name: '고객지원', speaker: 'support_lead' },
]
const T = Object.fromEntries(TEAMS.map(t => [t.id, t]))

const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍', '전', '고', '문', '양', '손', '배', '백', '허', '유', '남']
const GIVEN = ['서연', '민준', '지우', '도현', '하은', '예준', '수아', '시우', '지호', '유진', '준서', '채원', '건우', '나은', '현우', '지민', '태윤', '서현', '준혁', '소율', '은우', '다은', '지훈', '예린', '승현', '가은', '민재', '수빈', '우진', '아린', '정우', '하린', '재원', '윤서', '성민', '시은', '동현', '유나', '경민', '보람', '상훈', '세아', '영훈', '혜원', '진호', '규리', '태호', '슬기']
const ROLES = { pm: ['PM', '시니어 PM', '프로덕트 오너'], mech: ['기구 설계자', '수석 기구 엔지니어', '금형 담당'], hw: ['회로 설계자', '전원 엔지니어', 'EMC 담당'], fw: ['펌웨어 리드', '모터 제어 엔지니어', '센서 드라이버 담당'], nav: ['SLAM 엔지니어', '경로 계획 담당', '인식 엔지니어'], app: ['iOS 개발자', 'Android 개발자', '앱 리드'], cloud: ['백엔드 리드', 'IoT 플랫폼 엔지니어', 'DevOps'], qa: ['QA 리드', '신뢰성 시험 담당', '필드 품질 분석가'], ux: ['UX 리서처', '리서치 리드', '데이터 분석가'], design: ['ID 디자이너', 'UI 디자이너', 'CMF 담당'], scm: ['구매 리드', '부품 소싱 담당', 'SQE'], cert: ['인증 담당', '규제 리드', '개인정보 담당'], mfg: ['생산기술 리드', '라인 엔지니어', '수입검사 담당'], cs: ['CS 리드', 'CS 분석가', '기술지원 담당'] }

// 팀별 3명, 이름은 전역 유일
const PEOPLE = (() => {
  const rng = mulberry32(hash('people'))
  const given = sample(rng, GIVEN, TEAMS.length * 3)
  const out = []
  TEAMS.forEach((t, ti) => {
    for (let i = 0; i < 3; i++) {
      const name = pick(rng, SURNAMES) + given[ti * 3 + i]
      out.push({ name, team: t.id, role: ROLES[t.id][i], joined: fmt(randDate(rng, Date.UTC(2023, 0, 1), Date.UTC(2025, 6, 1))) })
    }
  })
  return out
})()
const peopleOf = teamId => PEOPLE.filter(p => p.team === teamId)
const lead = teamId => peopleOf(teamId)[0]

const COMPONENTS = [
  ['BLDC 흡입 모터', 'hw', '흡입'], ['사이클론 집진부', 'mech', '흡입'], ['먼지통 (600ml)', 'mech', '흡입'], ['헤파 필터', 'mech', '흡입'], ['메인 브러시 (러버 롤)', 'mech', '청소'], ['사이드 브러시', 'mech', '청소'], ['물걸레 모듈', 'mech', '청소'], ['물걸레 리프팅 모듈', 'mech', '청소'], ['물탱크 (300ml)', 'mech', '청소'], ['워터 펌프', 'hw', '청소'], ['진동 물걸레 패드', 'mech', '청소'],
  ['휠 모터', 'hw', '구동'], ['서스펜션 암', 'mech', '구동'], ['문턱 승월 보조 휠', 'mech', '구동'], ['캐스터 휠', 'mech', '구동'], ['휠 인코더', 'hw', '구동'],
  ['LDS 라이다 센서', 'hw', '센서'], ['전방 ToF 센서', 'hw', '센서'], ['절벽 감지 센서', 'hw', '센서'], ['범퍼 스위치', 'mech', '센서'], ['카펫 감지 센서 (초음파)', 'hw', '센서'], ['RGB 카메라 모듈', 'hw', '센서'], ['라인 레이저 모듈', 'hw', '센서'], ['먼지 농도 센서', 'hw', '센서'], ['자이로 IMU', 'hw', '센서'], ['벽면 추종 센서', 'hw', '센서'],
  ['메인보드 SoC', 'hw', '전장'], ['모터 드라이버 보드', 'hw', '전장'], ['Wi-Fi·BLE 모듈', 'hw', '전장'], ['스피커 앰프', 'hw', '전장'], ['마이크 어레이', 'hw', '전장'], ['LED 인디케이터 보드', 'hw', '전장'], ['배선 하네스', 'hw', '전장'], ['메인 커넥터 세트', 'hw', '전장'],
  ['배터리 팩 5200mAh', 'hw', '전원'], ['배터리 관리 회로 (BMS)', 'hw', '전원'], ['충전 접점', 'mech', '전원'], ['전원 어댑터', 'hw', '전원'],
  ['충전 도크', 'mech', '스테이션'], ['자동 비움 스테이션', 'mech', '스테이션'], ['먼지봉투 (3L)', 'mech', '스테이션'], ['스테이션 흡입 모터', 'hw', '스테이션'], ['물걸레 세척 트레이', 'mech', '스테이션'], ['자동 급배수 키트', 'mech', '스테이션'], ['온풍 건조 모듈', 'hw', '스테이션'],
  ['상판 커버', 'design', '외장'], ['범퍼 외장', 'design', '외장'], ['하부 섀시', 'mech', '외장'], ['먼지통 손잡이', 'design', '외장'], ['고무 씰', 'mech', '외장'], ['포장재', 'design', '외장'],
].map(([name, team, cat]) => ({ name, team, cat }))

const FEATURES = [
  ['실시간 맵핑', 'nav'], ['방 자동 분할', 'nav'], ['금지구역 설정', 'app'], ['가상 벽', 'app'], ['카펫 부스트', 'fw'], ['카펫에서 물걸레 리프팅', 'fw'], ['반려동물 배설물 회피', 'nav'], ['케이블 회피', 'nav'], ['문턱 넘기', 'mech'], ['예약 청소', 'app'], ['구역 지정 청소', 'app'], ['먼지통 자동 비움', 'fw'], ['다층 지도', 'nav'], ['음성 제어', 'fw'], ['음성 안내', 'fw'], ['소음 저감 모드', 'fw'], ['어린이 잠금', 'app'], ['청소 기록', 'app'], ['소모품 수명 관리', 'app'], ['OTA 업데이트', 'cloud'], ['자가 진단', 'fw'], ['분실물 감지', 'nav'], ['야간 모드', 'fw'], ['물걸레 자동 세척', 'fw'], ['온풍 건조', 'fw'], ['자동 급배수', 'mech'], ['방문 자동 감지', 'nav'], ['가구 아래 진입', 'mech'], ['흡입력 자동 조절', 'fw'], ['먼지 농도 기반 재청소', 'fw'], ['충전 후 이어 청소', 'fw'], ['지도 백업 복원', 'cloud'], ['멀티 유저 공유', 'cloud'], ['홈 화면 위젯', 'app'], ['스마트홈 연동', 'cloud'], ['원격 카메라 보기', 'app'], ['수동 조작 모드', 'app'], ['청소 순서 지정', 'app'], ['청소 시간 예측', 'nav'], ['도크 위치 자동 인식', 'nav'], ['에지 청소 강화', 'nav'], ['카펫 딥클린', 'fw'], ['얼룩 감지 재걸레질', 'nav'], ['에러 알림 푸시', 'cloud'], ['펫 모드', 'pm'], ['알러지 케어 모드', 'pm'], ['조용한 야간 도크 비움', 'fw'], ['한국어 음성 명령', 'fw'],
].map(([name, team]) => ({ name, team }))

const SYMPTOMS = [
  ['문턱에서 걸림', 'mech'], ['검정 카펫을 절벽으로 오인식', 'nav'], ['카펫 술 흡입 후 정지', 'mech'], ['도크 복귀 실패', 'nav'], ['Wi-Fi 연결 끊김', 'cloud'], ['앱에서 지도 사라짐', 'app'], ['배터리 급방전', 'hw'], ['소음이 표기값보다 큼', 'qa'], ['사이드 브러시 머리카락 엉킴', 'mech'], ['반려동물 배설물 회피 실패', 'nav'], ['물걸레가 카펫을 적심', 'fw'], ['자동 비움 시 먼지 역류', 'mech'], ['LDS 센서 오류 E12', 'hw'], ['물탱크 누수', 'mech'], ['OTA 후 부팅 실패', 'fw'], ['청소 기록 시간 불일치', 'app'], ['음성 명령 인식률 저하', 'fw'], ['예약 청소 미실행', 'cloud'], ['충전 접점 산화', 'hw'], ['휠 공회전', 'mech'], ['케이블 감김', 'nav'], ['금지구역 침범', 'nav'], ['가구 아래 갇힘', 'nav'], ['먼지통 가득 오탐', 'fw'], ['스테이션 흡입 소음 과다', 'mech'], ['앱 푸시 지연', 'cloud'], ['지도가 회전됨', 'nav'], ['범퍼 눌림 고착', 'mech'], ['저조도에서 장애물 미인식', 'nav'], ['배터리 충전 안 됨', 'hw'], ['물걸레 세척 후 냄새', 'mech'], ['먼지봉투 인식 실패', 'hw'], ['앱 로그인 실패', 'cloud'], ['청소 중 갑자기 정지', 'fw'], ['LED 깜빡임 오류', 'hw'], ['온풍 건조 과열 경고', 'hw'], ['벽 모서리 먼지 잔존', 'nav'], ['러버 롤 마모 조기 발생', 'mech'],
].map(([name, team]) => ({ name, team }))

const COMPETITORS = [
  { brand: '로보락', model: '로보락 플래그십 (2025)', strength: '장애물 인식', weakness: '가격' },
  { brand: '드리미', model: '드리미 L-시리즈', strength: '흡입력 수치', weakness: '앱 완성도' },
  { brand: '에코백스', model: '에코백스 X-시리즈', strength: '스테이션 구성', weakness: '소음' },
  { brand: '삼성 비스포크', model: '비스포크 제트봇 콤보', strength: '스마트홈 연동', weakness: '물걸레 성능' },
  { brand: 'LG 코드제로', model: '코드제로 로보킹', strength: 'AS 망', weakness: '맵핑 속도' },
  { brand: '다이슨', model: '다이슨 360 시리즈', strength: '집진 성능', weakness: '높이·문턱' },
  { brand: '아이로봇', model: '룸바 콤보 시리즈', strength: '브랜드 신뢰', weakness: '가성비' },
]
const SUPPLIERS = ['한빛모터', '대성배터리', '세진정밀', '유일전자', '동아플라텍', '광명센서', '나래테크', '삼우하네스', '청운고무', '태양광학', '미래필터', '금성브러시', '우성패키징', '서광메탈', '한울PCB', '신일모듈', '보광전원', '해성물류']
const REGS = ['KC 전기안전 인증', 'KC 전자파 적합성 (EMC)', 'KC 전파인증 (Wi-Fi·BLE)', '배터리 KC 안전확인', '에너지소비효율 표시', '소음 표시 기준', '개인정보보호 (카메라·지도 데이터)', 'CE 인증 (EU)', 'FCC 인증 (미국)', 'RoHS 유해물질', '전기용품 안전기준 개정 대응', '리콜 대응 절차']
const PERSONAS = ['맞벌이 부부 정윤아', '반려견 두 마리 가구 박현우', '노부모 돌봄 가구 이수진', '원룸 1인 가구 최민재', '대형 평수 주택 강도현', '알러지 아동 가구 한지원']
const GLOSSARY = [
  ['SLAM', '동시적 위치 추정과 지도 작성. 라이다·카메라·IMU를 합쳐 로봇이 어디에 있는지와 집 구조를 동시에 푼다.'], ['LDS', '레이저 거리 센서. 상판의 회전 라이다.'], ['ToF', '비행 시간 거리 센서. 전방 근거리 장애물용.'], ['BOM', '자재 명세서. 세대별로 부품·단가·공급사를 적는다.'], ['ECR', '설계 변경 요청. 부품·도면·펌웨어 규격 변경을 기록하고 승인받는 문서.'], ['DFM', '제조 용이성 설계. 금형·조립 관점의 설계 검토.'], ['EVT', '엔지니어링 검증 단계. 기능이 되는지 확인하는 첫 시제품.'], ['DVT', '설계 검증 단계. 신뢰성·인증 시험을 통과하는 설계로 굳힌다.'], ['PVT', '양산 검증 단계. 양산 라인에서 소량 생산해 공정을 검증한다.'], ['MP', '양산.'], ['OTA', '무선 펌웨어 업데이트.'], ['MTBF', '평균 고장 간격. 신뢰성 지표.'], ['흡입력 (Pa)', '파스칼 단위 정압 흡입력. 마케팅 수치와 실측이 다를 수 있다.'], ['소음 dB(A)', 'A 가중 음압 레벨. 표시 기준은 [[소음 표시 기준]] 참고.'], ['IMU', '관성 측정 장치. 자이로+가속도.'], ['BMS', '배터리 관리 회로.'], ['HEPA', '고효율 미립자 필터.'], ['FMEA', '고장 모드 영향 분석.'], ['DOA', '초기 불량(개봉 시 고장).'], ['불량률 (PPM)', '백만 개당 불량 수.'], ['PCBA', '부품이 실장된 회로 기판.'], ['ID·MD', '외관 디자인 / 기구 설계.'], ['VOC', '고객의 소리. 리뷰·CS·설문에서 모은 발언.'], ['NPS', '순추천지수.'], ['CS 티켓', '고객지원 문의 단위.'], ['골든 샘플', '양산 기준이 되는 표준 샘플.'], ['신뢰성 시험', '수명·환경·낙하 등 장기 시험.'], ['IP 등급', '방진·방수 등급.'], ['런타임', '만충 후 청소 가능한 시간.'], ['RTV', '반품.'], ['에지 청소', '벽 모서리 청소.'], ['커버리지', '지도 대비 실제 청소된 면적 비율.'], ['재청소율', '한 번 청소 후 사용자가 다시 청소를 시킨 비율.'], ['골드 마스터', '출시 확정 펌웨어 빌드.'], ['PPAP', '양산 부품 승인 절차.'], ['수입검사', '입고 부품 검사.'], ['캘리브레이션', '센서 교정.'], ['승월', '문턱을 넘는 것.'], ['리프팅', '카펫 위에서 물걸레를 들어올리는 동작.'], ['필드 불량', '고객 사용 중 발생한 불량.'],
].map(([term, desc]) => ({ term, desc }))
const PHANTOMS = ['S2 BOM 스프레드시트', '소음 측정 원본 데이터', '양산 일정표', 'Jira 보드', 'S1 필드 불량 대시보드', '경쟁사 가격 트래커']

// ── Vocabulary for templated prose ───────────────────────────────────────────

const CONCERNS = ['흡입력', '소음', '런타임', '문턱 승월', '카펫 대응', '물걸레 성능', '장애물 인식률', '맵핑 속도', '앱 반응성', '양산 원가', '조립 공수', '필드 불량률', '인증 일정', '반려동물 가구 대응', '먼지통 용량', '스테이션 크기', '세척 후 냄새', '펌웨어 안정성', '서버 비용', 'CS 문의량']
const RISKS = ['원가 상승', '일정 지연', '소음 증가', '런타임 감소', '금형 재제작', '인증 재시험', '공급사 리드타임', '사용자 혼란', '필드 불량 재발', '앱 스토어 리뷰 하락', '서버 부하', '개인정보 이슈']
const METRICS = ['흡입력 실측(Pa)', '소음(dB(A))', '런타임(분)', '문턱 승월 성공률', '장애물 회피 성공률', '맵핑 완료 시간', '커버리지', '재청소율', '7일 잔존율', 'CS 티켓 수', '앱 크래시율', '불량률(PPM)', '조립 택트타임', 'NPS', '리뷰 평점']
const VERBS = ['재설계했다', '확정했다', '보류했다', '되돌렸다', '단순화했다', '검증했다', '표준화했다', '분리했다', '통합했다', '폐기했다']
const OPINIONS = ['원가를 생각하면 무리다', '사용자 관점에선 당연히 필요하다', '일정상 이번 세대엔 어렵다', '경쟁사도 다 하고 있다', '필드 데이터가 먼저다', '금형 수정 없이 가능하다', '펌웨어만으로 해결 가능하다', '인증 재시험이 필요하다', 'CS 문의를 줄이는 효과가 크다', '실측치가 표기값과 너무 다르다']

function sentence(rng, links) {
  const [a, b] = sample(rng, links, 2)
  const A = L(a), B = L(b ?? a)
  return pick(rng, [
    `${josa(A, '과/와')} ${josa(B, '은/는')} ${pick(rng, CONCERNS)} 관점에서 같이 봐야 한다.`,
    `${josa(A, '을/를')} 바꾸면 ${josa(B, '이/가')} 같이 흔들린다. ${pick(rng, RISKS)} 리스크가 있다.`,
    `${pick(rng, CONCERNS)} 문제를 풀기 위해 ${A} 쪽 규격을 ${pick(rng, VERBS)}.`,
    `${B}에서 같은 증상이 ${int(rng, 2, 9)}번 관측됐다. 원인은 ${A} 쪽으로 좁혀진다.`,
    `시험 ${int(rng, 2, 8)}회차에서 ${pick(rng, METRICS)}이(가) ${int(rng, 3, 35)}% 움직였다 (${A} 기준).`,
    `${josa(A, '을/를')} 기준점으로 잡으면 ${B}의 목표치는 ${int(rng, 10, 90)}% 선에서 잡힌다.`,
    `${pick(rng, peopleOf(pick(rng, TEAMS).id)).name}의 의견: "${pick(rng, OPINIONS)}." ${A} 참고.`,
    `경쟁사(${pick(rng, COMPETITORS).brand})는 ${josa(B, '을/를')} 다르게 풀었다. 우리는 ${A} 방식을 유지한다.`,
    `${A} 변경은 ${pick(rng, GENS).name}부터 적용하고, ${josa(B, '은/는')} 다음 세대로 미룬다.`,
    `현장 데이터를 보면 ${josa(A, '이/가')} ${pick(rng, METRICS)}에 미치는 영향이 예상보다 ${pick(rng, ['크다', '작다', '반대 방향이다'])}.`,
  ])
}
const paragraph = (rng, links, n) => Array.from({ length: n }, () => sentence(rng, links)).join(' ')
const table = (rng, rows, unit = '') => ['| 항목 | 값 | 비고 |', '|------|----|------|', ...rows.map(r => `| ${r} | ${int(rng, 1, 999)}${unit} | ${pick(rng, ['임시', '확정', '검토 중', '실측', '목표'])} |`)].join('\n')

const fm = fields => ['---', ...Object.entries(fields).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => Array.isArray(v) ? `${k}: [${v.map(x => JSON.stringify(String(x))).join(', ')}]` : typeof v === 'boolean' || typeof v === 'number' ? `${k}: ${v}` : `${k}: ${JSON.stringify(String(v))}`), 'fake: true', '---'].join('\n')

// ── Registry ─────────────────────────────────────────────────────────────────

const ROOT = '온다'
const docs = []
const names = new Set()
function add(folder, name, fields, body) {
  if (names.has(name)) throw new Error(`duplicate document name: ${name}`)
  if (/[\/:*?"<>|]/.test(name)) throw new Error(`document name has a path/forbidden character (wikilinks would not resolve): ${name}`)
  names.add(name)
  docs.push({ path: `${ROOT}/${folder ? folder + '/' : ''}${name}.md`, name, date: fields.date, content: `${fm({ title: name, ...fields })}\n\n# ${name}\n\n${body.trim()}\n` })
}
const byDate = arr => [...arr].sort((a, b) => a.t - b.t)
const within = (arr, t, before, after = 7) => arr.filter(x => x.t >= t - before * DAY && x.t <= t + after * DAY)

// ── 1. 사람 · 팀 · 용어집 · 페르소나 ─────────────────────────────────────────

const rngP = mulberry32(hash('people-docs'))
for (const p of PEOPLE) {
  const team = T[p.team]
  const mates = peopleOf(p.team).filter(x => x !== p)
  add('사람', p.name, { type: 'person', speaker: team.speaker, team: team.name, role: p.role, date: p.joined, tags: ['person', team.id] }, [
    `**${team.name}팀** · ${p.role} · ${p.joined} 합류`, '',
    `## 담당`, `- 팀: ${L(`${team.name}팀`)}`, `- 주로 다루는 것: ${sample(rngP, [...COMPONENTS.filter(c => c.team === p.team), ...FEATURES.filter(f => f.team === p.team)].map(x => x.name), 3).map(L).join(', ') || '팀 전반'}`,
    `- 같이 일하는 사람: ${mates.map(x => L(x.name)).join(', ')}, ${L(pick(rngP, PEOPLE.filter(x => x.team !== p.team)).name)}`, '',
    `## 메모`, paragraph(rngP, [...COMPONENTS.map(c => c.name), ...FEATURES.map(f => f.name)], 2),
  ].join('\n'))
}
for (const t of TEAMS) {
  const members = peopleOf(t.id)
  add('팀', `${t.name}팀`, { type: 'team', speaker: t.speaker, date: '2024-06-03', tags: ['team', t.id, 'hub'] }, [
    `## 구성원`, members.map(m => `- ${L(m.name)} — ${m.role}${m === members[0] ? ' (리드)' : ''}`).join('\n'), '',
    `## 담당 영역`, [...COMPONENTS.filter(c => c.team === t.id).map(c => `- 부품: ${L(c.name)}`), ...FEATURES.filter(f => f.team === t.id).map(f => `- 기능: ${L(f.name)}`)].join('\n') || '- 전 제품 공통 업무', '',
    `## 정기 회의`, `- 주간회의: 매주 월요일 — ${L(`${t.name} 회의록 인덱스`)}`, `- 세대별 게이트 리뷰 참석: ${GENS.map(g => L(g.name)).join(', ')}`, '',
    `## 관련 프로세스`, `- ${L(`${CO} 볼트 안내`)}`, `- ${L('결정 기록 작성 가이드')}`, `- ${L('이슈 등록과 심각도 기준')}`, `- ${L(pick(rngP, ['ECR 승인 절차', '릴리스 체크리스트', '필드 불량 분석 절차', '공급사 감사 체크리스트']))}`,
  ].join('\n'))
}
for (const g of GLOSSARY) {
  add('용어집', g.term, { type: 'glossary', speaker: 'product_manager', date: '2024-06-10', tags: ['glossary'] }, [
    g.desc, '', `## 관련`, sample(rngP, [...GLOSSARY.filter(x => x !== g).map(x => x.term), ...COMPONENTS.map(c => c.name), ...FEATURES.map(f => f.name)], 4).map(x => `- ${L(x)}`).join('\n'),
  ].join('\n'))
}
for (const p of PERSONAS) {
  add('사용자 리서치/페르소나', p, { type: 'persona', speaker: 'ux_researcher', date: '2024-07-15', tags: ['research', 'persona'] }, [
    `## 상황`, paragraph(rngP, FEATURES.map(f => f.name), 3), '',
    `## 핵심 니즈`, sample(rngP, FEATURES, 4).map(f => `- ${L(f.name)} — ${pick(rngP, ['꼭 필요', '있으면 좋음', '이해 못함', '경쟁사에서 써봄'])}`).join('\n'), '',
    `## 불만 포인트`, sample(rngP, SYMPTOMS, 3).map(s => `- ${s.name}`).join('\n'), '',
    `## 관련 인터뷰`, `(인터뷰 문서에서 이 페르소나를 역링크로 참조)`,
  ].join('\n'))
}

// ── 2. 결정 기록 (DR) ────────────────────────────────────────────────────────

const DR_TOPICS = [
  ['흡입 모터를 {c}로 교체', 'hw'], ['{f} 기본값 변경', 'fw'], ['{f} 기능 {g}에서 제외', 'pm'], ['{f}을(를) {g} 출시 범위에 포함', 'pm'], ['{c} 공급사를 {s}로 이원화', 'scm'], ['{c} 단가 인하 협상 결과 반영', 'scm'], ['{f} 알고리즘을 규칙 기반에서 학습 기반으로 전환', 'nav'], ['{c} 규격 상향', 'mech'], ['{c} 금형 수정 대신 펌웨어 보정', 'mech'], ['{f} UI 흐름 재설계', 'app'], ['{f} 서버 처리에서 온디바이스 처리로 이동', 'cloud'], ['{f} 시험 기준 강화', 'qa'], ['{r} 대응 방식 확정', 'cert'], ['{c} 수입검사 항목 추가', 'mfg'], ['{f} 관련 CS 응대 스크립트 표준화', 'cs'], ['{c} 색상·마감 변경', 'design'], ['{f} 사용자 연구 결과에 따라 이름 변경', 'ux'], ['{g} 가격을 {p}원으로 확정', 'pm'], ['{f}에 {c} 사용', 'hw'], ['{f} 소음 목표를 {n}dB(A)로 설정', 'qa'], ['{c} 두께 {n}mm로 변경', 'mech'], ['{f} 실패 시 폴백 동작 정의', 'fw'], ['{g} 스테이션 구성 확정', 'pm'], ['{c} 재고 {n}주분 선확보', 'scm'], ['{f} 데이터 보관 기간 {n}일로 제한', 'cert'], ['{f} 베타 프로그램 운영', 'pm'], ['{c} 조립 순서 변경', 'mfg'], ['{f} 앱 온보딩에 추가', 'app'], ['{f}용 지도 포맷 v{n} 채택', 'nav'], ['{c} 폐기 기준 정의', 'qa'],
]
const DR_STATUS = ['채택', '채택', '채택', '채택', '거절', '보류', '초안']
function drTitle(rng, tpl) {
  return tpl.replace('{c}', pick(rng, COMPONENTS).name).replace('{f}', pick(rng, FEATURES).name).replace('{g}', pick(rng, GENS).name).replace('{s}로', josa(pick(rng, SUPPLIERS), '으로/로')).replace('{r}', pick(rng, REGS)).replace('{p}', String(int(rng, 45, 135) * 10000)).replace('{n}', String(int(rng, 2, 70)))
}
const DRS = (() => {
  const rng = mulberry32(hash('dr'))
  const out = []
  for (let i = 0; i < scaled(380); i++) {
    const [tpl, team] = pick(rng, DR_TOPICS)
    const t = randDate(rng)
    out.push({ t, team, title: drTitle(rng, tpl), status: pick(rng, DR_STATUS), gen: genFor(rng, t).id, author: pick(rng, peopleOf(team)).name })
  }
  const sorted = byDate(out)
  sorted.forEach((d, i) => { d.id = `DR-${String(i + 1).padStart(4, '0')}`; d.name = `${d.id} ${d.title}` })
  // 일부 결정은 나중에 같은 팀 결정으로 대체됨 → 폐기. 하지만 이후 문서들이 여전히 옛 결정을 인용한다.
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i]
    if (d.status !== '채택' || !chance(rng, 0.14)) continue
    const later = sorted.slice(i + 1).filter(x => x.team === d.team && x.status === '채택' && !x.supersedes)
    if (!later.length) continue
    const n = pick(rng, later.slice(0, 6))
    d.status = '폐기'; d.supersededBy = n.name; n.supersedes = d.name
  }
  return sorted
})()
const drsOf = teamId => DRS.filter(d => d.team === teamId)

// ── 3. 이슈 · ECR · 테스트 · 릴리스 (날짜 있는 항목들) ────────────────────────

const ISSUES = (() => {
  const rng = mulberry32(hash('issues'))
  const out = []
  for (let i = 0; i < scaled(720); i++) {
    const s = pick(rng, SYMPTOMS)
    const t = randDate(rng, Date.UTC(2024, 8, 1))
    const g = genFor(rng, t)
    // 증상을 낸 팀과 어울리는 부품군에서 의심 부품을 고른다 (앱 이슈에 온풍 건조 모듈이 걸리지 않게)
    const CATS = { fw: ['전장', '센서', '흡입', '청소'], nav: ['센서'], app: ['전장'], cloud: ['전장'], qa: null, mech: null, hw: null }
    const pool = CATS[s.team] ? COMPONENTS.filter(c => CATS[s.team].includes(c.cat)) : (COMPONENTS.filter(c => c.team === s.team).length ? COMPONENTS.filter(c => c.team === s.team) : COMPONENTS)
    const comp = pick(rng, pool)
    out.push({ t, team: s.team, symptom: s.name, comp: comp.name, gen: g.id, source: pick(rng, ['필드', '필드', '랩', '베타', '양산 라인', 'CS']), severity: pick(rng, ['치명', '높음', '높음', '보통', '보통', '낮음']), status: pick(rng, ['해결', '해결', '해결', '열림', '보류', '재현 불가']), reporter: pick(rng, PEOPLE).name })
  }
  const sorted = byDate(out)
  sorted.forEach((x, i) => { x.id = `ISS-${String(i + 1).padStart(4, '0')}`; x.name = `${x.id} ${x.symptom} (${x.gen})`.replace(/\s+/g, ' ') })
  // 이름 충돌 방지 (같은 증상+세대가 여러 번) — ID가 앞에 있어 유일함
  return sorted
})()
const ECRS = (() => {
  const rng = mulberry32(hash('ecr'))
  const out = []
  const kinds = ['커넥터 변경', '재질 변경', '치수 공차 조정', '도면 리비전', '공급사 변경', '표면 처리 변경', '나사 규격 통일', '체결 구조 변경', '배선 경로 변경', '펌웨어 파라미터 규격 변경']
  for (let i = 0; i < scaled(190); i++) {
    const c = pick(rng, COMPONENTS)
    const t = randDate(rng, Date.UTC(2024, 7, 1))
    out.push({ t, team: c.team, comp: c.name, kind: pick(rng, kinds), gen: genFor(rng, t).id, status: pick(rng, ['승인', '승인', '승인', '반려', '검토 중']), author: pick(rng, peopleOf(c.team)).name })
  }
  const sorted = byDate(out)
  sorted.forEach((x, i) => { x.id = `ECR-${String(i + 1).padStart(4, '0')}`; x.name = `${x.id} ${x.comp} ${x.kind}` })
  return sorted
})()
const TEST_KINDS = ['흡입력 시험', '소음 시험', '런타임 시험', '문턱 승월 시험', '카펫 청소 시험', '물걸레 얼룩 제거 시험', '장애물 회피 시험', '맵핑 정확도 시험', '무선 연결 안정성 시험', '수명 신뢰성 시험', '낙하 시험', '온습도 시험', 'EMC 사전 시험', '자동 비움 성능 시험', '스테이션 세척 시험', '반려동물 배설물 회피 시험', '케이블 회피 시험', '앱 성능 시험']
const TESTS = (() => {
  const rng = mulberry32(hash('tests'))
  const out = []
  for (const g of GENS) {
    for (const k of TEST_KINDS) {
      const rounds = scaled(int(rng, 2, 6))
      for (let r = 1; r <= rounds; r++) {
        const t = clampDate(g.start + Math.floor(rng() * ((g.launch ?? D1) - g.start + 120 * DAY)))
        out.push({ t, gen: g.id, kind: k, round: r, team: 'qa', verdict: pick(rng, ['합격', '합격', '조건부 합격', '불합격']), owner: pick(rng, peopleOf('qa')).name })
      }
    }
  }
  const sorted = byDate(out)
  sorted.forEach((x, i) => { x.id = `TR-${String(i + 1).padStart(4, '0')}`; x.name = `${x.id} ${x.gen} ${x.kind} ${x.round}차` })
  return sorted
})()
const FW = (() => {
  const rng = mulberry32(hash('fw'))
  const out = []
  for (const g of GENS) {
    let major = 1, minor = 0, patch = 0
    let t = g.start + 60 * DAY
    while (t < D1) {
      out.push({ t, gen: g.id, ver: `${major}.${minor}.${patch}`, team: 'fw', name: `${g.name} 펌웨어 ${major}.${minor}.${patch}` })
      t += int(rng, 9, 24) * DAY
      if (chance(rng, 0.2)) { minor++; patch = 0 } else patch++
      if (g.launch && t > g.launch && major === 1 && chance(rng, 0.15)) { major = 2; minor = 0; patch = 0 }
    }
  }
  return byDate(out)
})()
const APPV = (() => {
  const rng = mulberry32(hash('app'))
  const out = []
  let major = 1, minor = 0, patch = 0
  for (let t = D0 + 90 * DAY; t < D1; t += int(rng, 8, 20) * DAY) {
    out.push({ t, ver: `${major}.${minor}.${patch}`, team: 'app', name: `온다 앱 ${major}.${minor}.${patch}` })
    if (chance(rng, 0.05)) { major++; minor = 0; patch = 0 } else if (chance(rng, 0.3)) { minor++; patch = 0 } else patch++
  }
  return out
})()

// ── 4. 문서 본문 생성 ────────────────────────────────────────────────────────

const rng = mulberry32(hash('bodies'))
const genName = id => GENS.find(g => g.id === id).name
const linksFor = teamId => { const own = [...COMPONENTS.filter(c => c.team === teamId), ...FEATURES.filter(f => f.team === teamId)].map(x => x.name); return own.length >= 8 ? own : [...own, ...GENS.map(g => g.name), ...sample(rng, anyLinks(), 10)] }
const anyLinks = () => [...COMPONENTS.map(c => c.name), ...FEATURES.map(f => f.name)]
const phantom = () => pick(rng, PHANTOMS)

// 결정 기록
for (const d of DRS) {
  const team = T[d.team]
  const pool = [...linksFor(d.team), ...sample(rng, anyLinks(), 3)]
  const related = sample(rng, drsOf(d.team).filter(x => x !== d && x.t < d.t), 2).map(x => x.name)
  const issues = within(ISSUES, d.t, 60, 0).filter(x => x.team === d.team).slice(0, 3)
  const tests = within(TESTS, d.t, 45, 30).slice(0, 2)
  const options = sample(rng, ['현행 유지', '규격 상향', '공급사 변경', '펌웨어로 보정', '다음 세대로 이연', '옵션 액세서리로 분리', '외주 개발', '베타로 먼저 검증'], 3)
  add(`결정 기록/${team.name}`, d.name, { type: 'decision', speaker: team.speaker, team: team.name, status: d.status, generation: d.gen, date: fmt(d.t), author: d.author, supersedes: d.supersedes, superseded_by: d.supersededBy, tags: ['decision', team.id, d.gen.toLowerCase(), d.status] }, [
    `**상태:** ${d.status}${d.supersededBy ? ` → ${L(d.supersededBy)}(으)로 대체됨` : ''} · **대상:** ${L(genName(d.gen))} · **작성:** ${L(d.author)} (${team.name})`, '',
    `## 배경`, paragraph(rng, pool, 3), issues.length ? `\n관련 이슈: ${issues.map(x => L(x.name)).join(', ')}` : '', '',
    `## 대안`, options.map((o, i) => `${i + 1}. **${o}** — 장점: ${pick(rng, OPINIONS)}. 단점: ${pick(rng, RISKS)}.`).join('\n'), '',
    `## 결정`, d.status === '거절' ? `제안을 채택하지 않는다. ${pick(rng, OPINIONS)}.` : d.status === '보류' ? `${pick(rng, METRICS)} 데이터를 더 본 뒤 재논의한다.` : `${josa(options[0], '으로/로')} 간다. ${paragraph(rng, pool, 1)}`, '',
    `## 근거`, table(rng, sample(rng, METRICS, 4)), '',
    `## 영향`, sample(rng, pool, 3).map(x => `- ${L(x)}`).join('\n'), `- 원가: ${pick(rng, ['+', '-', '±'])}${int(rng, 0, 9)},${int(rng, 100, 999)}원/대`, `- 일정: ${pick(rng, ['영향 없음', `${int(rng, 1, 4)}주 지연`, '병렬 진행 가능'])}`, '',
    `## 후속`, `- ${pick(rng, peopleOf(d.team)).name} → ${pick(rng, ['ECR 발행', '시험 계획 수정', '공급사 통보', '앱 문구 수정', '릴리스 노트 반영'])}`, tests.length ? tests.map(x => `- 검증: ${L(x.name)}`).join('\n') : '', chance(rng, 0.35) ? `- 참고: ${L(phantom())}` : '', '',
    related.length ? `## 관련 결정\n${related.map(x => `- ${L(x)}`).join('\n')}${d.supersedes ? `\n- 이 결정이 대체함: ${L(d.supersedes)}` : ''}` : (d.supersedes ? `## 관련 결정\n- 이 결정이 대체함: ${L(d.supersedes)}` : ''),
  ].join('\n'))
}
add('결정 기록', '결정 기록 인덱스', { type: 'overview', speaker: 'product_manager', date: fmt(D1), tags: ['decision', 'hub'] }, [
  `결정 기록(DR)은 "배경 → 대안 → 결정 → 후속" 형식으로 남긴다. 작성 규칙은 ${L('결정 기록 작성 가이드')} 참고.`, '',
  `## 팀별`, TEAMS.map(t => `- ${L(`${t.name}팀`)}: ${drsOf(t.id).length}건 (채택 ${drsOf(t.id).filter(d => d.status === '채택').length}, 폐기 ${drsOf(t.id).filter(d => d.status === '폐기').length})`).join('\n'), '',
  `## 최근 결정`, DRS.slice(-25).reverse().map(d => `- ${fmt(d.t)} ${L(d.name)} — ${d.status}`).join('\n'), '',
  `## 폐기된 결정 (대체됨)`, DRS.filter(d => d.status === '폐기').map(d => `- ${L(d.name)} → ${L(d.supersededBy)}`).join('\n'),
].join('\n'))

// 기능
for (const f of FEATURES) {
  const team = T[f.team]
  const deps = sample(rng, COMPONENTS, int(rng, 2, 4)).map(c => c.name)
  const drs = sample(rng, DRS.filter(d => d.title.includes(f.name)).concat(sample(rng, drsOf(f.team), 2)), 4).map(d => d.name)
  const iss = sample(rng, ISSUES.filter(i => i.team === f.team), 3).map(i => i.name)
  add('제품/기능', f.name, { type: 'feature', speaker: team.speaker, team: team.name, date: fmt(randDate(rng, D0, D0 + 120 * DAY)), tags: ['feature', team.id] }, [
    `## 개요`, paragraph(rng, [...deps, ...FEATURES.filter(x => x !== f).slice(0, 8).map(x => x.name)], 3), '',
    `## 세대별 상태`, '| 세대 | 상태 | 비고 |', '|---|---|---|', GENS.map(g => `| ${L(g.name)} | ${pick(rng, ['미지원', '베타', '지원', '지원', '개선'])} | ${pick(rng, ['펌웨어 ' + pick(rng, FW.filter(x => x.gen === g.id)).ver + '부터', '출시 스펙', '차기 검토', '옵션'])} |`).join('\n'), '',
    `## 의존 부품`, deps.map(x => `- ${L(x)}`).join('\n'), '',
    `## 관련 결정`, [...new Set(drs)].map(x => `- ${L(x)}`).join('\n'), '',
    `## 알려진 이슈`, iss.map(x => `- ${L(x)}`).join('\n'), '',
    `## 사용자 반응`, `- 페르소나 ${L(pick(rng, PERSONAS))}: "${pick(rng, ['이게 되는 줄 몰랐다', '설정이 어디 있는지 못 찾겠다', '경쟁사보다 낫다', '소음이 더 커진 것 같다', '한 번 쓰고 안 쓴다'])}"`, `- 지표: ${pick(rng, METRICS)} ${int(rng, 3, 40)}% ${pick(rng, ['개선', '악화', '변화 없음'])}`, '',
    `## 시험`, sample(rng, TESTS, 2).map(x => `- ${L(x.name)}`).join('\n'),
  ].join('\n'))
}
// 부품
for (const c of COMPONENTS) {
  const team = T[c.team]
  const sup = sample(rng, SUPPLIERS, 2)
  const ecrs = ECRS.filter(e => e.comp === c.name).map(e => e.name)
  const iss = ISSUES.filter(i => i.comp === c.name).slice(0, 5).map(i => i.name)
  add('제품/부품', c.name, { type: 'component', speaker: team.speaker, team: team.name, category: c.cat, date: fmt(randDate(rng, D0, D0 + 90 * DAY)), tags: ['component', team.id, c.cat] }, [
    `## 사양 (가상)`, table(rng, ['단가(원)', '무게(g)', '수명(시간)', '리드타임(일)', '불량률(PPM)']), '',
    `## 공급사`, `- 주: ${L(sup[0])}`, `- 부: ${L(sup[1])}`, `- BOM: ${L(phantom())}`, '',
    `## 세대별 적용`, GENS.map(g => `- ${L(g.name)}: ${pick(rng, ['적용', '적용', '변경 적용', '미적용', '차기 검토'])}`).join('\n'), '',
    `## 관련 기능`, sample(rng, FEATURES, 3).map(f => `- ${L(f.name)}`).join('\n'), '',
    `## 설계 변경 이력`, ecrs.length ? ecrs.map(x => `- ${L(x)}`).join('\n') : '- 없음', '',
    `## 이슈`, iss.length ? iss.map(x => `- ${L(x)}`).join('\n') : '- 없음', '',
    `## 메모`, paragraph(rng, [...COMPONENTS.filter(x => x.cat === c.cat && x !== c).map(x => x.name), ...GLOSSARY.slice(0, 12).map(g => g.term)], 2),
  ].join('\n'))
}
// ECR
for (const e of ECRS) {
  const team = T[e.team]
  const dr = sample(rng, within(DRS, e.t, 90, 0).filter(d => d.team === e.team), 1).map(d => d.name)
  const iss = sample(rng, within(ISSUES, e.t, 90, 0).filter(i => i.comp === e.comp), 2).map(i => i.name)
  add(`제품/설계 변경 (ECR)`, e.name, { type: 'ecr', speaker: team.speaker, team: team.name, status: e.status, generation: e.gen, date: fmt(e.t), author: e.author, tags: ['ecr', team.id, e.gen.toLowerCase()] }, [
    `**대상 부품:** ${L(e.comp)} · **세대:** ${L(genName(e.gen))} · **상태:** ${e.status} · **작성:** ${L(e.author)}`, '',
    `## 변경 내용`, `${e.kind}. ${paragraph(rng, [e.comp, ...linksFor(e.team)], 2)}`, '',
    `## 사유`, iss.length ? iss.map(x => `- ${L(x)}`).join('\n') : `- ${pick(rng, CONCERNS)} 개선`, dr.length ? `- 근거 결정: ${L(dr[0])}` : '', '',
    `## 영향 범위`, `- 도면: ${pick(rng, ['리비전 B', '리비전 C', '신규'])}`, `- 금형: ${pick(rng, ['수정 없음', '코어 수정', '신규 제작'])}`, `- 재고: ${int(rng, 0, 12000)}개 ${pick(rng, ['소진 후 적용', '폐기', '리워크'])}`, `- 공급사: ${L(pick(rng, SUPPLIERS))}`, '',
    `## 승인`, `- ${L(lead(e.team).name)}: ${e.status}`, `- ${L(lead('mfg').name)}: ${pick(rng, ['동의', '조건부 동의', '검토 중'])}`, `- ${L(lead('scm').name)}: ${pick(rng, ['동의', '리드타임 확인 필요'])}`,
  ].join('\n'))
}
// 이슈
for (const i of ISSUES) {
  const team = T[i.team]
  const fix = pick(rng, ['dr', 'ecr', 'fw', 'none'])
  const dr = sample(rng, within(DRS, i.t, -1, 120).filter(d => d.team === i.team), 1)[0]
  const ecr = sample(rng, within(ECRS, i.t, -1, 120).filter(e => e.comp === i.comp), 1)[0]
  const fw = FW.filter(f => f.gen === i.gen && f.t > i.t)[0]
  const dup = sample(rng, ISSUES.filter(x => x.symptom === i.symptom && x !== i && x.t < i.t), 2).map(x => x.name)
  add(`이슈/${i.gen}`, i.name, { type: 'issue', speaker: team.speaker, team: team.name, status: i.status, severity: i.severity, source: i.source, generation: i.gen, component: i.comp, date: fmt(i.t), reporter: i.reporter, tags: ['issue', team.id, i.gen.toLowerCase(), i.severity] }, [
    `**심각도:** ${i.severity} · **출처:** ${i.source} · **상태:** ${i.status} · **세대:** ${L(genName(i.gen))} · **보고:** ${L(i.reporter)}`, '',
    `## 증상`, `${i.symptom}. ${pick(rng, ['사용자 ' + int(rng, 1, 40) + '명 보고.', '랩에서 ' + int(rng, 2, 30) + '회 중 ' + int(rng, 1, 10) + '회 재현.', '양산 라인 ' + int(rng, 1, 5) + '% 발생.', '베타 사용자 피드백.'])} 의심 부품: ${L(i.comp)}.`, '',
    `## 재현 조건`, `- 환경: ${pick(rng, ['검정 러그', '문턱 18mm', '카펫 술 긴 러그', '어두운 거실', '반려동물 있음', '2.4GHz 혼잡', '장모 카펫', '대리석 바닥'])}`, `- 펌웨어: ${pick(rng, FW.filter(f => f.gen === i.gen && f.t <= i.t).map(f => f.ver).concat(['초기']))}`, `- 빈도: ${pick(rng, ['항상', '자주', '가끔', '드물게'])}`, '',
    `## 원인 분석`, paragraph(rng, [i.comp, ...linksFor(i.team)], 3), dup.length ? `\n유사 이슈: ${dup.map(L).join(', ')}` : '', '',
    `## 조치`, fix === 'dr' && dr ? `- 결정: ${L(dr.name)}` : fix === 'ecr' && ecr ? `- 설계 변경: ${L(ecr.name)}` : fix === 'fw' && fw ? `- 펌웨어 수정: ${L(fw.name)}` : `- ${pick(rng, ['모니터링 중', 'CS 안내 문구 추가', '다음 세대에서 설계 반영', '재현 시도 계속'])}`, chance(rng, 0.25) ? `- 대시보드: ${L(phantom())}` : '', '',
    `## 관련`, `- 기능: ${L(pick(rng, FEATURES).name)}`, `- 담당: ${L(pick(rng, peopleOf(i.team)).name)}`,
  ].join('\n'))
}
// 테스트 리포트
for (const tr of TESTS) {
  const found = sample(rng, within(ISSUES, tr.t, 3, 14).filter(i => i.gen === tr.gen), int(rng, 0, 3)).map(i => i.name)
  const prev = TESTS.find(x => x.gen === tr.gen && x.kind === tr.kind && x.round === tr.round - 1)
  add(`테스트/${tr.gen}`, tr.name, { type: 'test-report', speaker: 'qa_engineer', team: '품질', generation: tr.gen, verdict: tr.verdict, round: tr.round, date: fmt(tr.t), author: tr.owner, tags: ['test', tr.gen.toLowerCase(), tr.verdict] }, [
    `**판정:** ${tr.verdict} · **세대:** ${L(genName(tr.gen))} · **담당:** ${L(tr.owner)}${prev ? ` · 이전 회차: ${L(prev.name)}` : ''}`, '',
    `## 시험 조건`, `- 샘플: ${pick(rng, ['EVT', 'DVT', 'PVT', '양산'])} ${int(rng, 3, 12)}대`, `- 펌웨어: ${pick(rng, FW.filter(f => f.gen === tr.gen).map(f => f.ver))}`, `- 기준: ${L(pick(rng, ['신뢰성 시험', '소음 dB(A)', '흡입력 (Pa)', '런타임', '커버리지']))}`, '',
    `## 결과`, table(rng, sample(rng, METRICS, 5)), '', `원본 데이터: ${L(phantom())}`, '',
    `## 발견 이슈`, found.length ? found.map(x => `- ${L(x)}`).join('\n') : '- 없음', '',
    `## 판단`, paragraph(rng, anyLinks(), 2), `${tr.verdict === '불합격' ? `재시험 필요. ${L(pick(rng, peopleOf('qa')).name)}이(가) ${pick(rng, TEAMS).name}팀과 원인 협의.` : '다음 단계 진행 가능.'}`,
  ].join('\n'))
}
// 펌웨어 · 앱 릴리스
for (const f of FW) {
  const fixed = within(ISSUES, f.t, 30, 0).filter(i => i.gen === f.gen && i.status === '해결').slice(0, 5).map(i => i.name)
  const feats = sample(rng, FEATURES, 3).map(x => x.name)
  add(`릴리스/펌웨어/${f.gen}`, f.name, { type: 'release', speaker: 'firmware_engineer', team: '펌웨어', generation: f.gen, version: f.ver, date: fmt(f.t), tags: ['release', 'firmware', f.gen.toLowerCase()] }, [
    `**대상:** ${L(genName(f.gen))} · **배포:** ${pick(rng, ['전체 OTA', '단계적 OTA 10%→100%', '베타 채널', '양산 이미지'])}`, '',
    `## 변경`, feats.map(x => `- ${L(x)} ${pick(rng, ['개선', '기본값 변경', '버그 수정', '베타 추가'])}`).join('\n'), '',
    `## 수정된 이슈`, fixed.length ? fixed.map(x => `- ${L(x)}`).join('\n') : '- 내부 안정화', '',
    `## 알려진 문제`, `- ${pick(rng, SYMPTOMS).name} — 다음 버전에서 수정 예정`, '',
    `## 검증`, `- ${L(pick(rng, TESTS.filter(t => t.gen === f.gen)).name)}`, `- 릴리스 체크리스트: ${L('릴리스 체크리스트')}`,
  ].join('\n'))
}
for (const a of APPV) {
  const fixed = within(ISSUES, a.t, 30, 0).filter(i => ['app', 'cloud'].includes(i.team)).slice(0, 4).map(i => i.name)
  add('릴리스/앱', a.name, { type: 'release', speaker: 'app_developer', team: '앱', version: a.ver, date: fmt(a.t), tags: ['release', 'app'] }, [
    `**플랫폼:** ${pick(rng, ['iOS + Android', 'Android 먼저', 'iOS 먼저'])} · **심사:** ${pick(rng, ['통과', '1회 반려 후 통과', '진행 중'])}`, '',
    `## 변경`, sample(rng, FEATURES.filter(f => ['app', 'cloud'].includes(f.team)), 3).map(f => `- ${L(f.name)} ${pick(rng, ['화면 개편', '설정 추가', '버그 수정', '온보딩 반영'])}`).join('\n'), '',
    `## 수정된 이슈`, fixed.length ? fixed.map(x => `- ${L(x)}`).join('\n') : '- 내부 리팩터링', '',
    `## 지표`, `- 크래시율 ${(rng() * 1.5).toFixed(2)}% · 리뷰 평점 ${(3.6 + rng() * 1.2).toFixed(1)}`,
  ].join('\n'))
}

// 회의록 — 팀별 주간 + 게이트 리뷰 + 월간 제품 리뷰
const AGENDA = ['{dr} 진행 상황', '{iss} 원인 공유', '{f} 일정 점검', '{c} 공급 이슈', '{tr} 결과 리뷰', '{g} 마일스톤 확인', '{iss} 재현 결과', '{f} 스펙 논의', '{c} 단가', '{dr} 후속 액션', '휴가·인력', '다음 주 우선순위']
const weekList = Array.from({ length: weeks + 1 }, (_, i) => D0 + i * 7 * DAY)
for (const team of TEAMS) {
  const members = peopleOf(team.id)
  for (const t of weekList) {
    if (chance(rng, 0.08)) continue // 가끔 회의 없음
    const drs = within(DRS, t, 28, 7).filter(d => d.team === team.id)
    const oldDrs = DRS.filter(d => d.team === team.id && d.status === '폐기' && d.t < t - 30 * DAY)
    const iss = within(ISSUES, t, 21, 7).filter(i => i.team === team.id)
    const trs = within(TESTS, t, 14, 7)
    const pickAgenda = () => pick(rng, AGENDA)
      .replace('{dr}', drs.length ? L(pick(rng, drs).name) : (oldDrs.length && chance(rng, 0.5) ? L(pick(rng, oldDrs).name) : L(pick(rng, DRS).name)))
      .replace('{iss}', iss.length ? L(pick(rng, iss).name) : L(pick(rng, ISSUES).name))
      .replace('{f}', L(pick(rng, FEATURES).name)).replace('{c}', L(pick(rng, COMPONENTS).name))
      .replace('{tr}', trs.length ? L(pick(rng, trs).name) : L(pick(rng, TESTS).name)).replace('{g}', L(genFor(rng, t).name))
    const agenda = [...new Set(Array.from({ length: int(rng, 3, 5) }, pickAgenda))]
    const guests = sample(rng, PEOPLE.filter(p => p.team !== team.id), int(rng, 0, 2))
    const name = `${fmt(t)} ${team.name} 주간회의`
    add(`회의록/${team.name}`, name, { type: 'meeting', speaker: team.speaker, team: team.name, date: fmt(t), tags: ['meeting', team.id, 'weekly'] }, [
      `**참석:** ${[...members, ...guests].map(p => L(p.name)).join(', ')}`, `**세대:** ${activeGens(t).map(g => L(g.name)).join(', ') || L('온다 S1')}`, '',
      `## 안건`, agenda.map((a, i) => `${i + 1}. ${a}`).join('\n'), '',
      `## 논의`, agenda.map(a => { const subj = [...a.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]); return `### ${a.replace(/\[\[|\]\]/g, '')}\n${paragraph(rng, [...subj, ...subj, ...linksFor(team.id)], int(rng, 2, 3))}` }).join('\n\n'), '',
      `## 결정`, `- ${pick(rng, ['보류', '진행', '재검토', '승인'])}: ${drs.length ? L(pick(rng, drs).name) : pick(rng, OPINIONS)}`, chance(rng, 0.3) ? `- ${L(phantom())} 업데이트` : '', '',
      `## 액션 아이템`, sample(rng, members, 2).map(m => `- [ ] ${L(m.name)}: ${pick(rng, ['원인 분석 정리', '공급사 회신 확인', '시험 계획 작성', '결정 기록 초안', '앱 문구 수정', 'CS 공유', '스펙 문서 갱신'])} (~${fmt(t + int(rng, 3, 14) * DAY)})`).join('\n'),
    ].join('\n'))
  }
}
for (const g of GENS) {
  for (const { phase, date } of genPhaseDates(g)) {
    if (date > D1) continue
    const name = `${fmt(date)} ${g.name} ${phase} 게이트 리뷰`
    const drs = within(DRS, date, 60, 0).filter(d => d.gen === g.id).slice(0, 6)
    const open = within(ISSUES, date, 60, 0).filter(i => i.gen === g.id && i.severity !== '낮음').slice(0, 6)
    const trs = within(TESTS, date, 45, 0).filter(x => x.gen === g.id).slice(0, 6)
    add(`회의록/게이트 리뷰`, name, { type: 'meeting', speaker: 'product_manager', team: '제품기획', generation: g.id, phase, date: fmt(date), tags: ['meeting', 'gate', g.id.toLowerCase()] }, [
      `**참석:** ${TEAMS.map(t => L(lead(t.id).name)).join(', ')}`, `**단계:** ${phase} · **제품:** ${L(g.name)}`, '',
      `## 진입 기준 점검`, ['기능 완성도', '신뢰성 시험', '인증 진행', '원가 목표', '양산 준비'].map(k => `- ${k}: ${pick(rng, ['충족', '충족', '조건부', '미충족'])}`).join('\n'), '',
      `## 주요 결정`, drs.map(d => `- ${L(d.name)} — ${d.status}`).join('\n') || '- 없음', '',
      `## 열린 이슈`, open.map(i => `- ${L(i.name)} (${i.severity})`).join('\n') || '- 없음', '',
      `## 시험 결과`, trs.map(x => `- ${L(x.name)} — ${x.verdict}`).join('\n') || '- 진행 중', '',
      `## 판정`, `${pick(rng, ['다음 단계 진행', '조건부 진행 — 2주 내 재점검', '1회 연기'])}. 일정은 ${L(phantom())} 참고. 로드맵: ${L(`${g.name} 로드맵`)}`,
    ].join('\n'))
  }
}
for (let m = 0; ; m++) {
  const t = Date.UTC(2024, 6 + m, 28)   // 매달 28일
  if (t > D1) break
  const name = `${month(t)} 월간 제품 리뷰`
  const drs = within(DRS, t, 30, 0).slice(0, 8)
  add('회의록/월간 제품 리뷰', name, { type: 'meeting', speaker: 'product_manager', team: '제품기획', date: fmt(t), tags: ['meeting', 'monthly'] }, [
    `**참석:** ${TEAMS.map(x => L(lead(x.id).name)).join(', ')}`, '',
    `## 세대별 현황`, activeGens(t).map(g => `- ${L(g.name)}: ${pick(rng, ['일정 내', '2주 지연', '리스크 있음', '출시 후 안정화'])} — ${paragraph(rng, anyLinks(), 1)}`).join('\n'), '',
    `## 이번 달 결정`, drs.map(d => `- ${L(d.name)}`).join('\n') || '- 없음', '',
    `## 지표`, table(rng, sample(rng, METRICS, 5)), '',
    `## 다음 달`, `- ${L(pick(rng, FEATURES).name)} 집중`, `- ${L(pick(rng, REGS))} 일정 확인`, `- 경쟁사 동향: ${L(pick(rng, COMPETITORS).brand)}`,
  ].join('\n'))
}

// 사용자 리서치
const rngR = mulberry32(hash('research'))
for (let i = 0; i < scaled(140); i++) {
  const t = randDate(rngR, D0 + 30 * DAY)
  const persona = pick(rngR, PERSONAS)
  const feats = sample(rngR, FEATURES, 4)
  const name = `UR-${String(i + 1).padStart(3, '0')} 인터뷰 — ${persona.split(' ').slice(0, -1).join(' ')} ${pick(rngR, SURNAMES)}○○`
  add('사용자 리서치/인터뷰', name, { type: 'interview', speaker: 'ux_researcher', team: '사용자리서치', persona, date: fmt(t), author: pick(rngR, peopleOf('ux')).name, tags: ['research', 'interview'] }, [
    `**페르소나:** ${L(persona)} · **사용 제품:** ${pick(rngR, [...GENS.map(g => L(g.name)), ...COMPETITORS.map(c => L(c.brand))])} · **진행:** ${L(pick(rngR, peopleOf('ux')).name)}`, '',
    `## 핵심 발언`, feats.map(f => `> "${pick(rngR, ['이 기능은 처음 알았어요', '설정이 너무 깊이 있어요', '이것 때문에 샀어요', '소리가 생각보다 커요', '반려견이 무서워해요', '문턱에서 자꾸 걸려요', '앱 알림이 너무 많아요', '물걸레 냄새가 나요'])}" — ${L(f.name)}`).join('\n'), '',
    `## 관찰`, paragraph(rngR, feats.map(f => f.name), 3), '',
    `## 시사점`, `- ${L(pick(rngR, feats).name)}: ${pick(rngR, ['발견성 개선 필요', '기본값 재검토', '온보딩에서 설명', '차기 세대 후보'])}`, `- 관련 이슈: ${L(pick(rngR, ISSUES).name)}`, `- 결정으로 연결: ${L(pick(rngR, DRS.filter(d => d.team === 'pm' || d.team === 'app')).name)}`,
  ].join('\n'))
}
for (let t = D0 + 200 * DAY; t < D1; t += 7 * DAY) {
  if (!chance(rngR, 0.85)) continue
  const name = `${fmt(t)} VOC 주간 리포트`
  const iss = within(ISSUES, t, 7, 0).filter(i => i.source === 'CS' || i.source === '필드').slice(0, 5)
  add('사용자 리서치/VOC', name, { type: 'voc', speaker: 'support_lead', team: '고객지원', date: fmt(t), tags: ['research', 'voc', 'weekly'] }, [
    `**티켓:** ${int(rngR, 40, 400)}건 · **리뷰:** ${int(rngR, 20, 200)}건 · **NPS:** ${int(rngR, 10, 60)}`, '',
    `## 상위 문의`, sample(rngR, SYMPTOMS, 5).map((s, i) => `${i + 1}. ${s.name} — ${int(rngR, 5, 80)}건 (${pick(rngR, ['↑', '↓', '→'])})`).join('\n'), '',
    `## 이슈로 등록`, iss.map(i => `- ${L(i.name)}`).join('\n') || '- 없음', '',
    `## 긍정 언급`, sample(rngR, FEATURES, 3).map(f => `- ${L(f.name)}`).join('\n'), '',
    `## 다음 주 요청`, `- ${pick(rngR, TEAMS).name}팀: ${paragraph(rngR, anyLinks(), 1)}`, `- 대시보드: ${L('S1 필드 불량 대시보드')}`,
  ].join('\n'))
}
for (let i = 0; i < 9; i++) {
  const t = D0 + (60 + i * 85) * DAY
  if (t > D1) break
  const name = `설문 ${i + 1} — ${pick(rngR, ['구매 요인', '사용 빈도', '기능 인지도', '가격 수용도', '소음 민감도', '반려동물 가구 니즈', '스테이션 선호', '앱 만족도', '재구매 의향'])}`
  add('사용자 리서치/설문', name, { type: 'survey', speaker: 'ux_researcher', team: '사용자리서치', date: fmt(t), tags: ['research', 'survey'] }, [
    `**응답:** ${int(rngR, 200, 2500)}명 · **채널:** ${pick(rngR, ['앱 내', '패널', '구매자 메일'])}`, '', `## 결과`, table(rngR, sample(rngR, FEATURES, 6).map(f => L(f.name)), '%'), '', `## 해석`, paragraph(rngR, FEATURES.map(f => f.name), 3), '', `## 연결`, `- ${L(pick(rngR, DRS).name)}`, `- ${L(pick(rngR, PERSONAS))}`,
  ].join('\n'))
}
for (let i = 0; i < scaled(26); i++) {
  const t = randDate(rngR, GENS[0].launch)
  const target = pick(rngR, [...GENS.filter(g => g.launch && g.launch < t).map(g => g.name), ...COMPETITORS.map(c => c.model)])
  const name = `리뷰 분석 ${String(i + 1).padStart(2, '0')} — ${target} (${month(t)})`
  add('사용자 리서치/리뷰 분석', name, { type: 'review-analysis', speaker: 'ux_researcher', team: '사용자리서치', date: fmt(t), tags: ['research', 'review'] }, [
    `**대상:** ${L(target)} · **표본:** 리뷰 ${int(rngR, 100, 3000)}건 · **평점:** ${(3.2 + rngR() * 1.6).toFixed(1)}`, '', `## 자주 나온 말`, sample(rngR, [...CONCERNS, ...SYMPTOMS.map(s => s.name)], 6).map(x => `- ${x} (${int(rngR, 3, 40)}%)`).join('\n'), '', `## 기능별`, sample(rngR, FEATURES, 4).map(f => `- ${L(f.name)}: ${pick(rngR, ['긍정', '부정', '혼재'])}`).join('\n'), '', `## 시사점`, paragraph(rngR, anyLinks(), 2),
  ].join('\n'))
}

// 경쟁사
for (const c of COMPETITORS) {
  add('경쟁사', c.brand, { type: 'competitor', speaker: 'product_manager', team: '제품기획', date: '2024-07-01', tags: ['competitor', 'hub'] }, [
    `대표 모델: ${L(c.model)}. 강점은 ${c.strength}, 약점은 ${c.weakness}. (가상 분석 — 실제 제품 정보와 무관)`, '', `## 우리와의 비교`, paragraph(rng, FEATURES.map(f => f.name), 3), '', `## 가격`, `- 추적: ${L('경쟁사 가격 트래커')}`, '', `## 관련 문서`, `- ${L(`${c.model} 티어다운`)}`, `- ${L(`${c.model} 기능 비교`)}`,
  ].join('\n'))
  add('경쟁사', c.model, { type: 'competitor-model', speaker: 'product_manager', team: '제품기획', date: '2024-07-01', tags: ['competitor'] }, [
    `${L(c.brand)}의 대표 모델. (가상)`, '', `## 스펙 (추정)`, table(rng, ['흡입력(Pa)', '소음(dB)', '런타임(분)', '가격(만원)', '스테이션 높이(mm)']), '', `## 기능`, sample(rng, FEATURES, 6).map(f => `- ${L(f.name)}: ${pick(rng, ['있음', '없음', '부분'])}`).join('\n'),
  ].join('\n'))
  add('경쟁사/티어다운', `${c.model} 티어다운`, { type: 'teardown', speaker: 'mechanical_engineer', team: '기구설계', date: fmt(randDate(rng, D0, D0 + 400 * DAY)), tags: ['competitor', 'teardown'] }, [
    `## 분해 소견`, paragraph(rng, COMPONENTS.map(x => x.name), 4), '', `## 우리 부품과 대응`, sample(rng, COMPONENTS, 5).map(x => `- ${L(x.name)} ↔ ${pick(rng, ['동급', '상위', '하위', '방식 다름'])}`).join('\n'), '', `## 원가 추정`, table(rng, ['BOM 합계(만원)', '부품 수', '조립 공수(분)']), '', `## 결정에 반영`, `- ${L(pick(rng, DRS).name)}`,
  ].join('\n'))
  add('경쟁사/기능 비교', `${c.model} 기능 비교`, { type: 'comparison', speaker: 'product_manager', team: '제품기획', date: fmt(randDate(rng, D0, D1)), tags: ['competitor', 'comparison'] }, [
    '| 기능 | 우리 | 경쟁 | 비고 |', '|---|---|---|---|', sample(rng, FEATURES, 10).map(f => `| ${L(f.name)} | ${pick(rng, ['O', 'X', '△'])} | ${pick(rng, ['O', 'X', '△'])} | ${pick(rng, ['동등', '우위', '열위', '방식 다름'])} |`).join('\n'), '', `## 판단`, paragraph(rng, FEATURES.map(f => f.name), 2),
  ].join('\n'))
}
for (const topic of ['흡입력 마케팅 수치', '스테이션 크기', '장애물 인식 방식', '물걸레 방식', '가격대 포지셔닝', '앱 온보딩', '소음 표기', '반려동물 기능', 'AS 정책', '소모품 가격']) {
  const [a, b] = sample(rng, COMPETITORS, 2)
  add('경쟁사/비교 분석', `${topic} 비교 — ${a.brand} vs ${b.brand}`, { type: 'analysis', speaker: 'product_manager', team: '제품기획', date: fmt(randDate(rng)), tags: ['competitor', 'analysis'] }, [
    `## 질문`, `우리 ${topic}을(를) 정할 때 ${L(a.brand)}와 ${L(b.brand)} 중 어느 접근이 맞는가.`, '', `## ${a.brand}`, paragraph(rng, [a.model, ...FEATURES.slice(0, 10).map(f => f.name)], 2), '', `## ${b.brand}`, paragraph(rng, [b.model, ...FEATURES.slice(10, 20).map(f => f.name)], 2), '', `## 결론`, `${pick(rng, ['전자', '후자', '절충'])}. 관련 결정: ${L(pick(rng, DRS.filter(d => d.team === 'pm')).name)}`,
  ].join('\n'))
}

// 공급사 · 규제
const rngS = mulberry32(hash('suppliers'))
for (const s of SUPPLIERS) {
  const parts = sample(rngS, COMPONENTS, int(rngS, 1, 4)).map(c => c.name)
  add('공급사', s, { type: 'supplier', speaker: 'sourcing_manager', team: '구매공급망', date: fmt(randDate(rngS, D0, D0 + 200 * DAY)), tags: ['supplier'] }, [
    `**위치:** ${pick(rngS, ['경기 화성', '인천 남동', '충남 천안', '경남 창원', '중국 둥관', '중국 선전', '베트남 하이퐁'])} · **등급:** ${pick(rngS, ['A', 'B', 'B', 'C'])} · **담당:** ${L(pick(rngS, peopleOf('scm')).name)}`, '',
    `## 공급 품목`, parts.map(p => `- ${L(p)}`).join('\n'), '', `## 조건`, table(rngS, ['리드타임(일)', 'MOQ', '단가 인하율(%)', '납기 준수율(%)', '수입검사 불량률(PPM)']), '', `## 이력`, paragraph(rngS, parts.concat(['수입검사', 'PPAP']), 2),
  ].join('\n'))
  for (let i = 0; i < scaled(4); i++) {
    const t = randDate(rngS, D0 + 60 * DAY)
    const kind = pick(rngS, ['견적', '감사', '품질 회의', '납기 협의'])
    const recName = `${fmt(t)} ${s} ${kind}`
    if (names.has(recName)) continue
    add('공급사/기록', recName, { type: 'supplier-record', speaker: 'sourcing_manager', team: '구매공급망', supplier: s, date: fmt(t), tags: ['supplier', kind] }, [
      `**공급사:** ${L(s)} · **품목:** ${L(pick(rngS, parts))} · **참석:** ${L(pick(rngS, peopleOf('scm')).name)}, ${L(pick(rngS, peopleOf(pick(rngS, ['mech', 'hw', 'mfg']))).name)}`, '', `## 내용`, paragraph(rngS, parts.concat(anyLinks().slice(0, 5)), 3), '', `## 결과`, `- ${pick(rngS, ['단가 ' + int(rngS, 1, 12) + '% 인하 합의', '리드타임 ' + int(rngS, 1, 6) + '주 단축', '시정 조치 요구', '2차 공급사 검토', '계약 갱신'])}`, `- 관련: ${L(pick(rngS, ECRS).name)}`, chance(rngS, 0.3) ? `- BOM: ${L('S2 BOM 스프레드시트')}` : '',
    ].join('\n'))
  }
}
for (const r of REGS) {
  add('규제·인증', r, { type: 'regulation', speaker: 'compliance_manager', team: '인증규제', date: '2024-08-01', tags: ['regulation', 'hub'] }, [
    `## 요구사항 요약`, paragraph(rngS, [...COMPONENTS.filter(c => c.team === 'hw').map(c => c.name), ...FEATURES.slice(0, 6).map(f => f.name)], 3), '', `## 영향 부품·기능`, sample(rngS, anyLinks(), 4).map(x => `- ${L(x)}`).join('\n'), '', `## 세대별 진행`, GENS.map(g => `- ${L(g.name)}: ${L(`${g.name} ${r} 진행 기록`)}`).join('\n'), '', `## 담당`, `- ${L(lead('cert').name)}`,
  ].join('\n'))
  for (const g of GENS) {
    const t = clampDate(g.start + int(rngS, 90, 300) * DAY)
    add('규제·인증/진행', `${g.name} ${r} 진행 기록`, { type: 'certification', speaker: 'compliance_manager', team: '인증규제', generation: g.id, status: pick(rngS, ['완료', '완료', '진행 중', '재시험']), date: fmt(t), tags: ['regulation', g.id.toLowerCase()] }, [
      `**규격:** ${L(r)} · **제품:** ${L(g.name)} · **시험소:** ${pick(rngS, ['KTL', 'KTC', 'KCL', 'SGS', 'TÜV'])}`, '', `## 일정`, `- 신청: ${fmt(t)}`, `- 시험: ${fmt(t + int(rngS, 7, 30) * DAY)}`, `- 결과: ${fmt(t + int(rngS, 31, 70) * DAY)}`, '', `## 이슈`, `- ${pick(rngS, ['1차 시험 불합격 — 재시험', '서류 보완', '샘플 재제출', '없음'])}`, `- 관련: ${L(pick(rngS, DRS.filter(d => d.team === 'cert' || d.team === 'hw')).name)}`, `- 시험 리포트: ${L(pick(rngS, TESTS.filter(x => x.gen === g.id)).name)}`,
    ].join('\n'))
  }
}

// 제품 허브 · 로드맵 · 프로세스 · 볼트 안내 · 고아 메모
for (const g of GENS) {
  const phases = genPhaseDates(g)
  add('제품', g.name, { type: 'product', speaker: 'product_manager', team: '제품기획', generation: g.id, date: fmt(g.start), price: g.price, tags: ['product', 'hub', g.id.toLowerCase()] }, [
    `${g.tagline}. 가격 ${g.price.toLocaleString('ko-KR')}원${g.launch ? `, ${fmt(g.launch)} 출시` : ', 개발 중'}.`, '',
    `## 핵심 기능`, sample(rng, FEATURES, 12).map(f => `- ${L(f.name)}`).join('\n'), '', `## 주요 부품`, sample(rng, COMPONENTS, 14).map(c => `- ${L(c.name)}`).join('\n'), '',
    `## 단계`, phases.map(p => `- ${p.phase}: ${fmt(p.date)}${p.date <= D1 ? ` — ${L(`${fmt(p.date)} ${g.name} ${p.phase} 게이트 리뷰`)}` : ' (예정)'}`).join('\n'), '',
    `## 로드맵`, `- ${L(`${g.name} 로드맵`)}`, '', `## 이슈·결정`, `- 이슈 ${ISSUES.filter(i => i.gen === g.id).length}건, 결정 ${DRS.filter(d => d.gen === g.id).length}건 — ${L('결정 기록 인덱스')}`, `- 최신 펌웨어: ${L(FW.filter(f => f.gen === g.id).slice(-1)[0].name)}`,
  ].join('\n'))
  add('로드맵', `${g.name} 로드맵`, { type: 'roadmap', speaker: 'product_manager', team: '제품기획', generation: g.id, date: fmt(g.start), tags: ['roadmap', g.id.toLowerCase()] }, [
    `## 마일스톤`, phases.map(p => `- ${p.phase} — ${fmt(p.date)}`).join('\n'), '', `## 범위`, sample(rng, FEATURES, 8).map(f => `- ${L(f.name)}: ${pick(rng, ['필수', '필수', '선택', '이연'])}`).join('\n'), '', `## 리스크`, sample(rng, RISKS, 4).map(r => `- ${r}`).join('\n'), '', `## 월간 업데이트`, `(월간 제품 리뷰 회의록 참고 — ${L(phantom())})`,
  ].join('\n'))
}
const PROCESS = [
  ['결정 기록 작성 가이드', 'pm'], ['이슈 등록과 심각도 기준', 'qa'], ['ECR 승인 절차', 'mech'], ['릴리스 체크리스트', 'fw'], ['필드 불량 분석 절차', 'qa'], ['공급사 감사 체크리스트', 'scm'], ['신뢰성 시험 계획 템플릿', 'qa'], ['앱 스토어 심사 대응', 'app'], ['개인정보 영향평가 절차', 'cert'], ['양산 이관 체크리스트', 'mfg'], ['CS 에스컬레이션 규칙', 'cs'], ['사용자 인터뷰 가이드', 'ux'], ['게이트 리뷰 진입 기준', 'pm'], ['OTA 배포 단계 정책', 'cloud'], ['금형 수정 승인 기준', 'mech'], ['신규 입사자 온보딩', 'pm'], ['볼트 문서 작성 규칙', 'pm'], ['펌웨어 브랜치 전략', 'fw'],
]
for (const [name, team] of PROCESS) {
  add('프로세스', name, { type: 'process', speaker: T[team].speaker, team: T[team].name, date: '2024-06-17', tags: ['process'] }, [
    `## 목적`, paragraph(rng, GLOSSARY.map(g => g.term), 2), '', `## 절차`, Array.from({ length: int(rng, 4, 6) }, (_, i) => `${i + 1}. ${pick(rng, ['초안 작성', '리드 검토', '관련 팀 의견 수렴', '게이트 리뷰 보고', '문서 상태 갱신', '결정 기록 링크', '이슈 링크', '시험 리포트 첨부'])}`).join('\n'), '', `## 관련`, `- ${L(`${T[team].name}팀`)}`, `- ${L(pick(rng, GLOSSARY).term)}`, `- 예시: ${L(pick(rng, DRS).name)}`,
  ].join('\n'))
}
add('', `${CO} 볼트 안내`, { type: 'overview', speaker: 'product_manager', date: fmt(D1), tags: ['hub'] }, [
  `${CO}는 로봇청소기를 만드는 가상의 회사다. 이 볼트는 ${fmt(D0)}부터 ${fmt(D1)}까지 세 세대(${GENS.map(g => L(g.name)).join(', ')})를 개발하며 쌓인 문서다. **전부 생성된 가상 데이터**이며 실제 회사·제품·인물과 무관하다.`, '',
  `## 시작점`, `- 제품: ${GENS.map(g => L(g.name)).join(', ')}`, `- 결정: ${L('결정 기록 인덱스')}`, `- 팀: ${TEAMS.map(t => L(`${t.name}팀`)).join(', ')}`, `- 규칙: ${L('볼트 문서 작성 규칙')}, ${L('결정 기록 작성 가이드')}`, `- 인덱스: ${['ECR 인덱스', '온다 앱 릴리스 인덱스', '인터뷰 인덱스', 'VOC 인덱스', '설문 인덱스', '리뷰 분석 인덱스', '공급사 기록 인덱스', '경쟁사 인덱스', '규제·인증 인덱스', '구성원 인덱스', '용어집 인덱스', '프로세스 인덱스'].map(L).join(', ')}`, `- 세대별 인덱스: ${GENS.flatMap(g => [`${g.name} 이슈 인덱스`, `${g.name} 테스트 인덱스`, `${g.name} 펌웨어 릴리스 인덱스`]).map(L).join(', ')}`, `- 팀 회의록: ${TEAMS.map(t => L(`${t.name} 회의록 인덱스`)).join(', ')} · ${L('월간 제품 리뷰 인덱스')} · ${L('게이트 리뷰 인덱스')}`, '',
  `## 폴더`, ['결정 기록/<팀>', '제품/기능 · 제품/부품 · 제품/설계 변경 (ECR)', '이슈/<세대>', '테스트/<세대>', '릴리스/펌웨어 · 릴리스/앱', '회의록/<팀> · 회의록/게이트 리뷰 · 회의록/월간 제품 리뷰', '사용자 리서치/인터뷰 · VOC · 설문 · 리뷰 분석 · 페르소나', '경쟁사 · 공급사 · 규제·인증', '사람 · 팀 · 용어집 · 프로세스 · 로드맵'].map(x => `- ${x}`).join('\n'), '',
  `## 문서 수`, `- 결정 ${DRS.length} · 이슈 ${ISSUES.length} · ECR ${ECRS.length} · 테스트 ${TESTS.length} · 펌웨어 릴리스 ${FW.length} · 앱 릴리스 ${APPV.length}`,
].join('\n'))
// 인덱스(MOC) 문서 — 실제 볼트처럼 목록 문서가 개별 항목을 가리킨다
const byMonth = items => { const m = {}; for (const x of items) (m[month(x.t)] ??= []).push(x); return Object.entries(m).sort() }
const inFolder = folder => docs.filter(d => d.path.startsWith(`${ROOT}/${folder}/`)).map(d => ({ t: Date.parse(d.date), name: d.name }))
for (const team of TEAMS) {
  const mine = inFolder(`회의록/${team.name}`)
  add('회의록', `${team.name} 회의록 인덱스`, { type: 'overview', speaker: team.speaker, team: team.name, date: fmt(D1), tags: ['meeting', team.id, 'hub'] }, [
    `${L(`${team.name}팀`)} 주간회의 ${mine.length}건.`, '', ...byMonth(mine).map(([m, xs]) => `## ${m}\n${xs.map(x => `- ${L(x.name)}`).join('\n')}`),
  ].join('\n'))
}
for (const g of GENS) {
  const iss = ISSUES.filter(i => i.gen === g.id)
  add('이슈', `${g.name} 이슈 인덱스`, { type: 'overview', speaker: 'qa_engineer', team: '품질', generation: g.id, date: fmt(D1), tags: ['issue', g.id.toLowerCase(), 'hub'] }, [
    `${L(g.name)} 이슈 ${iss.length}건. 열림 ${iss.filter(i => i.status === '열림').length}, 치명 ${iss.filter(i => i.severity === '치명').length}.`, '',
    `## 열림 · 치명/높음`, iss.filter(i => i.status === '열림' && ['치명', '높음'].includes(i.severity)).map(i => `- ${L(i.name)} (${i.severity}, ${L(i.comp)})`).join('\n') || '- 없음', '',
    `## 증상별`, ...Object.entries(iss.reduce((m, i) => ((m[i.symptom] ??= []).push(i), m), {})).sort().map(([sym, xs]) => `### ${sym} (${xs.length})\n${xs.map(i => `- ${fmt(i.t)} ${L(i.name)} — ${i.status}`).join('\n')}`),
  ].join('\n'))
  const trs = TESTS.filter(x => x.gen === g.id)
  add('테스트', `${g.name} 테스트 인덱스`, { type: 'overview', speaker: 'qa_engineer', team: '품질', generation: g.id, date: fmt(D1), tags: ['test', g.id.toLowerCase(), 'hub'] }, [
    `${L(g.name)} 시험 ${trs.length}건.`, '', ...TEST_KINDS.map(k => `## ${k}\n${trs.filter(x => x.kind === k).map(x => `- ${x.round}차 ${fmt(x.t)} ${L(x.name)} — ${x.verdict}`).join('\n')}`),
  ].join('\n'))
  const fws = FW.filter(f => f.gen === g.id)
  add('릴리스/펌웨어', `${g.name} 펌웨어 릴리스 인덱스`, { type: 'overview', speaker: 'firmware_engineer', team: '펌웨어', generation: g.id, date: fmt(D1), tags: ['release', 'firmware', g.id.toLowerCase(), 'hub'] }, [
    `${L(g.name)} 펌웨어 ${fws.length}개 버전.`, '', ...fws.map(f => `- ${fmt(f.t)} ${L(f.name)}`),
  ].join('\n'))
}
add('회의록', '월간 제품 리뷰 인덱스', { type: 'overview', speaker: 'product_manager', team: '제품기획', date: fmt(D1), tags: ['meeting', 'monthly', 'hub'] }, inFolder('회의록/월간 제품 리뷰').map(d => `- ${L(d.name)}`).join('\n'))
add('회의록', '게이트 리뷰 인덱스', { type: 'overview', speaker: 'product_manager', team: '제품기획', date: fmt(D1), tags: ['meeting', 'gate', 'hub'] }, inFolder('회의록/게이트 리뷰').map(d => `- ${L(d.name)}`).join('\n'))
add('릴리스', '온다 앱 릴리스 인덱스', { type: 'overview', speaker: 'app_developer', team: '앱', date: fmt(D1), tags: ['release', 'app', 'hub'] }, [`앱 ${APPV.length}개 버전.`, '', ...APPV.map(a => `- ${fmt(a.t)} ${L(a.name)}`)].join('\n'))
add('제품', 'ECR 인덱스', { type: 'overview', speaker: 'mechanical_engineer', team: '기구설계', date: fmt(D1), tags: ['ecr', 'hub'] }, [`설계 변경 ${ECRS.length}건.`, '', ...byMonth(ECRS).map(([m, xs]) => `## ${m}\n${xs.map(e => `- ${L(e.name)} — ${e.status} (${L(e.comp)})`).join('\n')}`)].join('\n'))
for (const sub of ['인터뷰', 'VOC', '설문', '리뷰 분석']) {
  const mine = inFolder(`사용자 리서치/${sub}`)
  add('사용자 리서치', `${sub} 인덱스`, { type: 'overview', speaker: 'ux_researcher', team: '사용자리서치', date: fmt(D1), tags: ['research', 'hub'] }, [`${sub} ${mine.length}건.`, '', ...byMonth(mine).map(([m, xs]) => `## ${m}\n${xs.map(x => `- ${L(x.name)}`).join('\n')}`)].join('\n'))
}
add('공급사', '공급사 기록 인덱스', { type: 'overview', speaker: 'sourcing_manager', team: '구매공급망', date: fmt(D1), tags: ['supplier', 'hub'] }, SUPPLIERS.map(s => `## ${L(s)}\n${inFolder('공급사/기록').filter(d => d.name.includes(` ${s} `)).map(d => `- ${L(d.name)}`).join('\n') || '- 없음'}`).join('\n\n'))
add('경쟁사', '경쟁사 인덱스', { type: 'overview', speaker: 'product_manager', team: '제품기획', date: fmt(D1), tags: ['competitor', 'hub'] }, [...COMPETITORS.map(c => `- ${L(c.brand)} — ${L(c.model)} · ${L(`${c.model} 티어다운`)} · ${L(`${c.model} 기능 비교`)}`), '', '## 비교 분석', ...inFolder('경쟁사/비교 분석').map(d => `- ${L(d.name)}`)].join('\n'))
add('규제·인증', '규제·인증 인덱스', { type: 'overview', speaker: 'compliance_manager', team: '인증규제', date: fmt(D1), tags: ['regulation', 'hub'] }, REGS.map(r => `- ${L(r)}: ${GENS.map(g => L(`${g.name} ${r} 진행 기록`)).join(' · ')}`).join('\n'))
add('사람', '구성원 인덱스', { type: 'overview', speaker: 'product_manager', date: fmt(D1), tags: ['person', 'hub'] }, TEAMS.map(t => `## ${L(`${t.name}팀`)}\n${peopleOf(t.id).map(p => `- ${L(p.name)} — ${p.role}`).join('\n')}`).join('\n\n'))
add('용어집', '용어집 인덱스', { type: 'overview', speaker: 'product_manager', date: fmt(D1), tags: ['glossary', 'hub'] }, GLOSSARY.map(g => `- ${L(g.term)} — ${g.desc.replace(/\[\[|\]\]/g, '').slice(0, 40)}`).join('\n'))
add('프로세스', '프로세스 인덱스', { type: 'overview', speaker: 'product_manager', date: fmt(D1), tags: ['process', 'hub'] }, PROCESS.map(([n, t]) => `- ${L(n)} (${T[t].name})`).join('\n'))

// 고아 문서 (아무도 링크하지 않음)
for (const [name, body] of [['아이디어 메모 — 창문 청소 로봇', '창문 청소 로봇 아이디어. 흡착 방식과 안전 줄. 검토 안 됨.'], ['아이디어 메모 — 잔디깎이 확장', '같은 내비게이션 스택으로 잔디깎이를 만들 수 있을까. 보류.'], ['2024 워크숍 후기', '팀 워크숍 후기. 사진은 드라이브에.'], ['옛 네이밍 후보 목록', '온다 이전에 검토한 브랜드 이름 후보들.'], ['사무실 이전 체크리스트', '2025년 사무실 이전 때 쓴 목록.']]) {
  add('기타', name, { type: 'memo', speaker: 'product_manager', date: fmt(randDate(rng)), tags: ['memo'] }, `${body}\n\n${paragraph(rng, anyLinks(), 1)}`)
}

// ── Output ───────────────────────────────────────────────────────────────────

const bytes = docs.reduce((n, d) => n + Buffer.byteLength(d.content), 0)
console.log(`${docs.length} documents, ${(bytes / 1048576).toFixed(1)} MB (scale ${SCALE})`)

if (OUT) {
  for (const d of docs) {
    const file = join(OUT, d.path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, d.content, 'utf-8')
  }
  console.log(`written to ${OUT}`)
}

if (SERVER) {
  const headers = { authorization: `Bearer ${TOKEN}`, 'x-author': encodeURIComponent(AUTHOR) }
  const api = (path, init = {}) => fetch(`${SERVER}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })

  if (WIPE) {
    let since = 0, removed = 0
    for (;;) {
      const page = await (await api(`/v1/manifest?since=${since}`)).json()
      for (const row of page.files) {
        if (row.deleted || !WIPE_PREFIXES.some(p => row.path.startsWith(p))) continue
        const r = await api(`/v1/file?path=${encodeURIComponent(row.path)}`, { method: 'DELETE' })
        if (r.ok || r.status === 404) removed++
      }
      if (page.next === null) break
      since = page.next
    }
    console.log(`wiped ${removed} files under ${WIPE_PREFIXES.join(', ')}`)
  }

  let created = 0, unchanged = 0, failed = 0, done = 0
  const queue = [...docs]
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      let r
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          r = await api(`/v1/file?path=${encodeURIComponent(d.path)}`, {
            method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-mtime': String(Date.now()) }, body: new TextEncoder().encode(d.content),
          })
          if (r.status < 500) break
        } catch { r = null }
        await new Promise(res => setTimeout(res, 1000 * (attempt + 1)))
      }
      if (!r) { failed++; console.error(`unreachable ${d.path}`) }
      else if (r.status === 201 || r.status === 200) created++
      else if (r.status === 204) unchanged++
      else { failed++; console.error(`${r.status} ${d.path}: ${(await r.text()).slice(0, 120)}`) }
      if (++done % 500 === 0) console.log(`  ${done}/${docs.length}`)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  console.log(`uploaded to ${SERVER}: ${created} written, ${unchanged} unchanged, ${failed} failed`)
  if (failed) process.exit(1)
}
