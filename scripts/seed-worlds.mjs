#!/usr/bin/env node
/**
 * Seed a Strata Sync vault with FAKE game-world design documents.
 *
 * Generates a few hundred Korean markdown documents about well-known game universes (Pokémon,
 * Warhammer 40K, Baldur's Gate, D&D, Elden Ring, …). Only the proper nouns are real; every
 * number, date, decision and "design note" is invented from templates, so the vault behaves
 * like a real team vault (folders, frontmatter, dense wikilinks, cross-universe analyses, a few
 * phantom links for the linter) without copying any wiki text.
 *
 *   node scripts/seed-worlds.mjs --out ./seed-vault                       # write to a folder
 *   node scripts/seed-worlds.mjs --server https://<worker> --token <team token> [--out …]
 *   node scripts/seed-worlds.mjs --server … --token … --wipe             # delete every seeded file first
 *
 * Deterministic: the same universe always produces the same documents (mulberry32 PRNG).
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
if (!OUT && !SERVER) { console.error('usage: seed-worlds.mjs --out <dir> | --server <url> --token <token> [--wipe]'); process.exit(2) }
if (SERVER && !TOKEN) { console.error('--server needs --token (or STRATA_TEAM_TOKEN)'); process.exit(2) }

// ── PRNG ─────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 } return h }
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]
const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))
const sample = (rng, arr, n) => { const a = [...arr]; const out = []; while (a.length && out.length < n) out.push(a.splice(Math.floor(rng() * a.length), 1)[0]); return out }

// ── Universes (real names only; everything about them below is invented) ─────

const U = [
  { name: 'Pokémon', slug: 'pokemon', genre: '수집·육성 RPG', tone: '밝고 모험적',
    factions: ['로켓단', '포켓몬 리그', '사천왕', '포켓몬 센터 네트워크', '갤럭시단'],
    characters: ['지우', '피카츄', '로사', '난천', '오박사', '목호', '레드', '단델', '리자몽', '이브이', '뮤츠', '루카리오'],
    locations: ['태초마을', '무지개시티', '석영고원', '하나 지방', '가라르 지방', '알로라 지방', '별의 동굴', '챔피언 로드'],
    items: ['몬스터볼', '마스터볼', '자전거', '진화의 돌', '기술머신', '이상한 사탕', '메가스톤'],
    systems: ['타입 상성', '진화', '배틀 시스템', '포획 확률', '개체값과 노력치'] },
  { name: 'Warhammer 40K', slug: 'warhammer-40k', genre: '그림다크 SF 전략', tone: '음울하고 장엄',
    factions: ['스페이스 마린', '카오스 스페이스 마린', '아스트라 밀리타룸', '오크', '엘다', '타이라니드', '네크론', '타우'],
    characters: ['황제', '로부테 길리먼', '아바돈', '가즈쿨', '엘드라드', '카디아의 크리드', '트라진', '샤드서스'],
    locations: ['테라', '카디아', '마크라그', '아마겟돈', '눈의 성좌', '커모라', '옥타리우스'],
    items: ['볼터', '체인소드', '파워 아머', '드레드노트', '타이탄', '워프 드라이브', '게이트 오브 인피니티'],
    systems: ['워프 항해', '워기어 편성', '사기 체크', '군단 조직', '포인트 밸런스'] },
  { name: "Baldur's Gate 3", slug: 'baldurs-gate-3', genre: '파티 기반 CRPG', tone: '극적이고 선택 중심',
    factions: ['압솔루트 교단', '하퍼', '젠타림', '불꽃주먹단', '드루이드 결사'],
    characters: ['아스타리온', '섀도하트', '게일', '레이젤', '윌', '카를락', '할신', '민타라', '황제', '오린', '고타쉬', '케세릭 톰'],
    locations: ['발더스 게이트', '그림자 저주의 땅', '에메랄드 숲', '문라이즈 타워', '언더다크', '나우틸로이드', '엘프송 여관'],
    items: ['블러드 오브 라사드', '네더리즈 스톤', '가시의 검', '마법사의 로브', '치유 물약', '허공의 구슬'],
    systems: ['다이스 판정', '긴 휴식', '대화 설득', '캠프 관계도', '높이 이점'] },
  { name: 'Dungeons & Dragons', slug: 'dnd', genre: '테이블톱 RPG', tone: '자유롭고 협동적',
    factions: ['하퍼', '로드 얼라이언스', '에메랄드 엔클레이브', '젠타림', '레드 위저드'],
    characters: ['드리즈트 도어덴', '엘민스터', '스트라드', '베크나', '티아마트', '볼로', '모덴카이넨', '탸샤'],
    locations: ['워터딥', '언더마운틴', '바로비아', '네버윈터', '아이스윈드 데일', '시길', '칸델킵'],
    items: ['바그 오브 홀딩', '보팔 소드', '소원의 반지', '주문서', '홀리 어벤저', '데크 오브 매니 씽즈'],
    systems: ['d20 판정', '어드밴티지', '주문 슬롯', '레벨업 규칙', '휴식과 회복', '난이도 등급'] },
  { name: 'Elden Ring', slug: 'elden-ring', genre: '오픈월드 소울라이크', tone: '적막하고 신화적',
    factions: ['황금 나무 결사', '카리아 왕가', '볼카노 장원', '손가락 낭독자', '고룡 신앙'],
    characters: ['멜리나', '라니', '말레니아', '라다곤', '고드릭', '라단', '모그', '블라이드', '밀리센트', '렌나라'],
    locations: ['림그레이브', '리에니에', '케일리드', '알터 고원', '왕도 로데일', '거인들의 산령', '지하 신수탑'],
    items: ['엘든 링', '대 룬', '전회', '성배병', '유적 대검', '달빛 대검', '기억의 돌'],
    systems: ['룬 손실', '전회 커스텀', '영체 소환', '축복 워프', '스탯 보정'] },
  { name: 'The Witcher', slug: 'witcher', genre: '내러티브 액션 RPG', tone: '회색빛 도덕',
    factions: ['늑대 유파', '닐프가드 제국', '스코이아텔', '레다니아', '로지 의식단'],
    characters: ['게롤트', '예니퍼', '시리', '트리스', '단델라이언', '베스미어', '에므히르', '디크스트라', '올기어드'],
    locations: ['케르 모헨', '노비그라드', '벨렌', '스켈리게', '툿상', '카에드 웬', '오센푸르트'],
    items: ['은검', '강철검', '위쳐 메달리온', '변이 유발 물질', '아드 표식', '켈피 활'],
    systems: ['표식 마법', '오일과 폭탄', '위쳐 감각', '변이 트리', '궨트 카드'] },
  { name: 'The Legend of Zelda', slug: 'zelda', genre: '액션 어드벤처', tone: '경쾌하고 탐험적',
    factions: ['하이랄 왕국', '게르도', '조라', '고론', '리토', '이가단'],
    characters: ['링크', '젤다', '가논', '미파', '리발', '다르켈', '우르보사', '임파', '시드'],
    locations: ['하이랄 성', '카카리코 마을', '조라의 영역', '데스 마운틴', '게르도 사막', '시련의 사당', '하늘 섬'],
    items: ['마스터 소드', '하일리아의 방패', '시커 스톤', '패러세일', '울트라핸드', '스크래빌드', '하트 조각'],
    systems: ['물리 기반 퍼즐', '무기 내구도', '사당 진행', '요리', '기후와 장비'] },
  { name: 'Final Fantasy XIV', slug: 'ffxiv', genre: 'MMORPG', tone: '서사적이고 연대기적',
    factions: ['불멸의 화염단', '검은장미 기사단', '쌍사당', '가레말 제국', '아씨엔'],
    characters: ['빛의 전사', '알피노', '알리제', '이젤', '하우체팡', '에메트셀크', '제노스', '탄크레드', '야슈톨라'],
    locations: ['림사 로민사', '그리다니아', '울다하', '이슈가르드', '크리스타리움', '샤를레안', '라자한'],
    items: ['소울 크리스탈', '에테라이트', '토메스톤', '릴릭 웨폰', '초코보 휘슬', '마테리아'],
    systems: ['잡 시스템', '레이드 기믹', '길 이코노미', '하우징', '리밋 브레이크'] },
  { name: 'Genshin Impact', slug: 'genshin', genre: '오픈월드 가챠 RPG', tone: '화사하고 낭만적',
    factions: ['페보니우스 기사단', '천령', '우인단', '이나즈마 막부', '팔레스 왕립 아카데미'],
    characters: ['여행자', '페이몬', '종려', '벤티', '라이덴 쇼군', '나히다', '푸리나', '다이루크', '각청', '타르탈리아'],
    locations: ['몬드', '리월', '이나즈마', '수메르', '폰타인', '드래곤 스파인', '층암거연'],
    items: ['원석', '기도', '성유물', '무기 돌파 재료', '기행', '풍신의 눈', '신의 눈'],
    systems: ['원소 반응', '가챠 확률', '성유물 파밍', '세계 등급', '레진'] },
  { name: 'Star Wars', slug: 'star-wars', genre: '스페이스 오페라', tone: '영웅적이고 대립적',
    factions: ['제다이 의회', '시스', '은하 제국', '반란 연합', '퍼스트 오더', '만달로리안'],
    characters: ['루크 스카이워커', '다스 베이더', '레아', '한 솔로', '요다', '오비완', '아소카', '그로구', '카일로 렌', '레이'],
    locations: ['타투인', '코러산트', '호스', '엔도', '무스타파', '다고바', '만달로어', '나부'],
    items: ['라이트세이버', '밀레니엄 팔콘', '데스 스타', '베스카', '카이버 크리스탈', '홀로크론'],
    systems: ['포스 정렬', '함선 전투', '광선검 유파', '현상금 시스템', '진영 평판'] },
  { name: 'Mass Effect', slug: 'mass-effect', genre: 'SF 롤플레잉 슈터', tone: '정치적이고 결단적',
    factions: ['얼라이언스', '시타델 의회', '서버러스', '리퍼', '게스', '쿼리안 이주 함대'],
    characters: ['셰퍼드', '가루스', '리아라', '탈리', '렉스', '모딘', '조커', '일루시브 맨', '레기온', '사렌'],
    locations: ['시타델', '노르망디', '투찬카', '일로스', '오메가', '지구', '팔라벤'],
    items: ['오멘툴', '매스 릴레이', '바이오틱 앰프', '메딕젤', '탈리의 마스크', '크루서블'],
    systems: ['파라곤/레니게이드', '스쿼드 명령', '바이오틱 콤보', '로열티 미션', '함선 업그레이드'] },
  { name: 'Dark Souls', slug: 'dark-souls', genre: '액션 RPG', tone: '쇠락하고 순환적',
    factions: ['태양의 전사', '어둠의 추종자', '화톳불의 수호자', '용의 계약', '심연의 감시자'],
    characters: ['그윈', '아르토리아스', '솔라', '오른슈타인', '스모우', '시프', '군데르', '녹슨 에스트', '화방녀'],
    locations: ['불사의 교구', '아노르 론도', '병자의 마을', '흑의 숲 정원', '로스릭 고성', '이자리스', '재의 묘소'],
    items: ['에스트', '영혼 조각', '가시의 반지', '흑기사 검', '용사냥꾼의 활', '태양의 메달'],
    systems: ['영혼 손실', '화톳불 리스폰', '패리와 백스탭', '인간성', '무기 강화'] },
  { name: 'Monster Hunter', slug: 'monster-hunter', genre: '협동 액션', tone: '박진감 있고 협동적',
    factions: ['길드', '조사단', '용인족', '수인족', '왕립 고문서관'],
    characters: ['헌터', '조사단장', '접수원', '대장장이', '아이루', '카무라 마을 장로', '알마', '올리비아'],
    locations: ['고대수의 숲', '용결정의 땅', '카무라 마을', '수풀 평원', '설원', '아스테라', '용의 침소'],
    items: ['회복약', '고기 구이', '소재', '대검', '용격포', '슬링어', '용의 보옥'],
    systems: ['부위 파괴', '소재 드롭 테이블', '무기 트리', '몬스터 AI 루틴', '4인 협동 배율'] },
  { name: 'Hollow Knight', slug: 'hollow-knight', genre: '메트로바니아', tone: '고요하고 애상적',
    factions: ['할로우네스트 왕국', '페일 킹의 궁정', '사마귀 부족', '딥네스트', '눈물의 도시 의회'],
    characters: ['기사', '호넷', '퀴렐', '엘더버그', '슬라이', '그림 단장', '이젤다', '코르니퍼', '지나'],
    locations: ['더트마우스', '잊혀진 교차로', '녹색 길', '균사의 황무지', '눈물의 도시', '왕의 무덤', '심연'],
    items: ['몽의 못', '부적', '가면 조각', '영혼 용기', '비단 지도', '왕의 인장'],
    systems: ['부적 조합', '영혼 게이지', '지도 수집', '벤치 세이브', '꿈의 못'] },
  { name: 'Cyberpunk 2077', slug: 'cyberpunk-2077', genre: '오픈월드 FPS RPG', tone: '네온과 냉소',
    factions: ['아라사카', '밀리테크', '애프터라이프', '발렌티노', '보이투', '노마드 알데칼도'],
    characters: ['V', '조니 실버핸드', '주디', '파남', '잭키 웰스', '타케무라', '로그', '아담 스매셔', '사부로 아라사카'],
    locations: ['나이트 시티', '워슨', '웨스트브룩', '퍼시피카', '배드랜드', '독타운', '아라사카 타워'],
    items: ['사이버웨어', '렐릭', '맨티스 블레이드', '샌디스톰', '브레인댄스', '넷러너 데크'],
    systems: ['해킹 퀵핵', '사이버웨어 용량', '평판과 거래', '길거리 신용', '릴릭 능력'] },
  { name: 'World of Warcraft', slug: 'warcraft', genre: 'MMORPG', tone: '장대하고 진영적',
    factions: ['얼라이언스', '호드', '불타는 군단', '스컬지', '리치 왕의 군대', '용군단'],
    characters: ['스랄', '제이나', '아서스', '실바나스', '일리단', '안두인', '티란데', '볼진', '데스윙'],
    locations: ['스톰윈드', '오그리마', '아이스크라운', '아웃랜드', '판다리아', '어둠땅', '용의 섬'],
    items: ['프로스트모운', '둠해머', '아쉬브링거', '전설 망토', '하스스톤', '비행 탈것'],
    systems: ['진영 전쟁', '레이드 로스터', '전문 기술', '탈란트 트리', '신화+ 던전'] },
  { name: 'The Elder Scrolls', slug: 'elder-scrolls', genre: '오픈월드 RPG', tone: '자유롭고 서사적',
    factions: ['블레이드', '어둠의 형제단', '도둑 길드', '마법 대학', '스톰클록', '제국군'],
    characters: ['도바킨', '알두인', '파르투르낙스', '델핀', '에스번', '울프릭', '세라나', '툴리우스', '시세로'],
    locations: ['화이트런', '솔리튜드', '윈드헬름', '리프튼', '고지 타르', '소브느가르드', '블랙리치'],
    items: ['용의 뼈 갑옷', '검은 별', '오그마 인피니움', '보이드 소금', '용의 언어 두루마리', '엘더 스크롤'],
    systems: ['드래곤 샤우트', '기술 숙련', '라디언트 퀘스트', '인챈트', '스탯 없는 성장'] },
  { name: 'Persona 5', slug: 'persona-5', genre: 'JRPG', tone: '스타일리시하고 반항적',
    factions: ['심의 괴도단', '벨벳 룸', '이면 세계', '시부야 경찰', '오쿠무라 푸드'],
    characters: ['조커', '모르가나', '류지', '안', '유스케', '마코토', '후타바', '하루', '아케치', '이고르', '쇼지'],
    locations: ['르블랑', '슈진 학원', '메멘토스', '팰리스', '시부야', '요코하마', '벨벳 룸'],
    items: ['페르소나', '코옵 랭크', '가면', '치유 아이템', '총기', '스킬 카드'],
    systems: ['코옵 시스템', '캘린더 진행', '약점 원모어', '총공격', '페르소나 합체'] },
  { name: 'Fire Emblem', slug: 'fire-emblem', genre: 'SRPG', tone: '비극적이고 전략적',
    factions: ['페르가스 성기사단', '아드레스티아 제국', '레스터 동맹', '세이로스 교회', '아가르타'],
    characters: ['벨레트', '에델가르트', '디미트리', '클로드', '레아', '마르스', '루키나', '크롬', '아이크'],
    locations: ['가르그마크 수도원', '엔바르', '펠디아', '데어드루', '알테어', '텔리우스', '포도라'],
    items: ['천제의 검', '팔시온', '영웅의 유산', '기병 인장', '마스터 실', '가시 선언서'],
    systems: ['무기 삼각형', '클래스 체인지', '지원 관계', '영구 사망', '배틀 전술'] },
]

// ── Vocabulary for templated prose ───────────────────────────────────────────

const SPEAKERS = ['chief_director', 'art_director', 'plan_director', 'level_director', 'prog_director']
const VERBS = ['재설계했다', '확장했다', '단순화했다', '검증했다', '폐기했다', '되살렸다', '표준화했다', '분리했다']
const CONCERNS = ['난이도 곡선', '신규 유저 진입', '엔드게임 반복성', '경제 인플레이션', '서사 일관성', '멀티플레이 동기화', '컨트롤러 조작감', '로딩 시간', '현지화 텍스트 길이', '접근성 옵션']
const RISKS = ['밸런스 붕괴', '파밍 피로', '선택의 무의미화', '스토리 스포일러', '치트 취약점', '메모리 예산 초과', 'UI 정보 과부하']
const METRICS = ['평균 세션 길이', '7일 잔존율', '보스 첫 격파 시도 횟수', '퀘스트 완료율', '설정 화면 진입률', '튜토리얼 이탈률', '파티 편성 다양성 지수']
const MONTHS = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']

const sentence = (rng, u, links) => {
  const [a, b] = sample(rng, links, 2).map(link)
  return pick(rng, [
    `${a}와(과) ${b}의 관계는 ${pick(rng, CONCERNS)} 관점에서 다시 봐야 한다.`,
    `이 요소는 ${a}에 직접 영향을 주고, 간접적으로는 ${b}까지 흔든다.`,
    `${u.name}의 ${pick(rng, CONCERNS)} 문제를 풀기 위해 ${a} 쪽 규칙을 ${pick(rng, VERBS)}.`,
    `리스크는 ${pick(rng, RISKS)}. ${b}에서 같은 문제가 ${int(rng, 2, 9)}번 관측됐다.`,
    `플레이테스트 ${int(rng, 3, 12)}회차에서 ${pick(rng, METRICS)}이(가) ${int(rng, 4, 38)}% 움직였다.`,
    `${a}을(를) 기준점으로 잡으면 ${b}의 수치는 ${int(rng, 10, 90)}% 선에서 잡힌다.`,
  ])
}
const paragraph = (rng, u, links, n) => Array.from({ length: n }, () => sentence(rng, u, links)).join(' ')

const table = (rng, rows) => [
  '| 항목 | 값 | 비고 |', '|------|----|------|',
  ...rows.map(r => `| ${r} | ${int(rng, 1, 999)} | ${pick(rng, ['임시', '확정', '검토 중', 'v0.' + int(rng, 1, 9)])} |`),
].join('\n')

const fm = (rng, { title, tags, type }) => [
  '---',
  `title: "${title.replace(/"/g, '')}"`,
  `speaker: ${pick(rng, SPEAKERS)}`,
  `date: ${pick(rng, MONTHS)}-${String(int(rng, 1, 28)).padStart(2, '0')}`,
  `type: ${type}`,
  `tags: [${tags.map(t => JSON.stringify(t)).join(', ')}]`,
  'fake: true',
  '---',
].join('\n')

const link = name => `[[${name}]]`

// ── Document builders ────────────────────────────────────────────────────────

function universeDocs(u) {
  const rng = mulberry32(hash(u.slug))
  const docs = []
  const folder = `worlds/${u.name}`
  const all = [...u.factions, ...u.characters, ...u.locations, ...u.items, ...u.systems]
  const add = (name, type, tags, body) => docs.push({ path: `${folder}/${name}.md`, content: `${fm(rng, { title: name, tags: [...new Set([u.slug, 'fake-data', type, ...tags])], type })}\n\n# ${name}\n\n${body}\n` })

  // Hub
  add(`${u.name} 세계관 개요`, 'overview', ['hub'], [
    `${u.name}은(는) ${u.genre}이고 톤은 "${u.tone}"이다. 이 문서는 팀이 참고용으로 정리한 **가상의 설계 노트**이며 실제 작품 설정과 다르다.`,
    '', '## 진영', u.factions.map(f => `- ${link(f)}`).join('\n'),
    '', '## 주요 인물', u.characters.map(c => `- ${link(c)}`).join('\n'),
    '', '## 장소', u.locations.map(l => `- ${link(l)}`).join('\n'),
    '', '## 아이템·장비', u.items.map(i => `- ${link(i)}`).join('\n'),
    '', '## 시스템', u.systems.map(s => `- ${link(s)}`).join('\n'),
    '', '## 우리 프로젝트와의 접점', paragraph(rng, u, u.systems, 3),
  ].join('\n'))

  for (const f of u.factions) {
    const members = sample(rng, u.characters, int(rng, 2, 4))
    const base = pick(rng, u.locations)
    add(f, 'faction', ['faction'], [
      `## 개요`, `${f}은(는) ${u.name}에서 ${pick(rng, ['질서', '혼돈', '균형', '확장', '생존', '복수'])}을(를) 대표하는 세력이다. 근거지는 ${link(base)}. 대표 인물: ${members.map(link).join(', ')}.`,
      '', '## 설계 포인트', paragraph(rng, u, [...u.systems, ...u.factions.filter(x => x !== f)], 4),
      '', '## 세력 수치 (가상)', table(rng, ['영향력', '병력 규모', '평판 상한', '퀘스트 수']),
      '', '## 관련', `- 대립: ${link(pick(rng, u.factions.filter(x => x !== f)))}`, `- 세계관: ${link(`${u.name} 세계관 개요`)}`,
    ].join('\n'))
  }

  for (const c of u.characters) {
    const faction = pick(rng, u.factions)
    const home = pick(rng, u.locations)
    const gear = sample(rng, u.items, 2)
    add(c, 'character', ['character'], [
      `## 개요`, `${c}은(는) ${link(faction)} 소속(또는 관계자)으로, ${link(home)}에서 처음 등장한다. 주 장비: ${gear.map(link).join(', ')}.`,
      '', '## 역할과 아크', paragraph(rng, u, [...u.characters.filter(x => x !== c), ...u.systems], 4),
      '', '## 능력치 초안 (가상)', table(rng, ['체력', '공격', '방어', '속도', '호감도 상한']),
      '', '## 관련', `- ${link(`${u.name} 세계관 개요`)}`, `- 시스템: ${link(pick(rng, u.systems))}`,
    ].join('\n'))
  }

  for (const l of u.locations) {
    const owner = pick(rng, u.factions)
    add(l, 'location', ['location'], [
      `## 개요`, `${l}은(는) ${link(owner)}의 영향권에 있는 지역이다. 핵심 콘텐츠: ${sample(rng, u.systems, 2).map(link).join(', ')}.`,
      '', '## 레벨 디자인 메모', paragraph(rng, u, [...u.locations.filter(x => x !== l), ...u.characters], 4),
      '', '## 지표 (가상)', table(rng, ['권장 레벨', '체류 시간(분)', '수집품 수', '적 배치 수']),
      '', '## 관련', `- ${link(`${u.name} 세계관 개요`)}`, `- 등장 인물: ${sample(rng, u.characters, 2).map(link).join(', ')}`,
    ].join('\n'))
  }

  for (const it of u.items) {
    add(it, 'item', ['item'], [
      `## 개요`, `${it}은(는) ${link(pick(rng, u.systems))} 시스템과 맞물리는 핵심 아이템이다. 주 사용자: ${link(pick(rng, u.characters))}.`,
      '', '## 밸런스 노트', paragraph(rng, u, [...u.items.filter(x => x !== it), ...u.systems], 3),
      '', '## 수치 (가상)', table(rng, ['획득 난이도', '가격', '내구도', '강화 단계']),
      '', '## 관련', `- ${link(`${u.name} 세계관 개요`)}`,
    ].join('\n'))
  }

  for (const s of u.systems) {
    add(s, 'system', ['system', 'mechanics'], [
      `## 개요`, `${u.name}의 ${s}은(는) ${pick(rng, CONCERNS)}을(를) 해결하기 위한 장치다. 우리 프로젝트에서는 ${pick(rng, ['그대로 참고', '변형해서 차용', '반면교사로', '부분 도입'])}한다.`,
      '', '## 규칙', paragraph(rng, u, [...u.systems.filter(x => x !== s), ...u.items], 4),
      '', '## 튜닝 파라미터 (가상)', table(rng, ['기본값', '상한', '하한', '리셋 주기']),
      '', '## 관련', `- ${link(`${u.name} 세계관 개요`)}`, `- 대표 아이템: ${link(pick(rng, u.items))}`, `- 대표 장소: ${link(pick(rng, u.locations))}`,
    ].join('\n'))
  }

  // A few dated review notes per universe (design-team flavour)
  for (let i = 0; i < 3; i++) {
    const topic = pick(rng, u.systems)
    const name = `${u.name} 리뷰 노트 ${i + 1} — ${topic}`
    add(name, 'review', ['review', 'meeting'], [
      `## 결정 사항`, `- ${topic}을(를) ${pick(rng, VERBS)}.`, `- 담당: ${pick(rng, SPEAKERS)}`, `- 근거: ${pick(rng, METRICS)} ${int(rng, 5, 40)}% 변화`,
      '', '## 논의', paragraph(rng, u, [topic, ...sample(rng, all, 5)], 5),
      '', '## 후속', `- ${link(pick(rng, u.locations))}에서 재검증`, `- ${link(pick(rng, u.characters))} 관련 대사 수정`,
      `- 참고: ${link(`${u.name} 밸런스 스프레드시트`)}`, // deliberate phantom link (referenced 3× per universe) so graph_lint has something to flag
    ].join('\n'))
  }
  return docs
}

function crossDocs() {
  const rng = mulberry32(hash('cross'))
  const docs = []
  const topics = [
    ['성장 시스템', 'systems'], ['보스 설계', 'characters'], ['오픈월드 밀도', 'locations'], ['진영 갈등', 'factions'],
    ['아이템 경제', 'items'], ['죽음 페널티', 'systems'], ['동료 관계도', 'characters'], ['튜토리얼 구간', 'locations'],
  ]
  for (const [topic, key] of topics) {
    for (let n = 0; n < 3; n++) {
      const [a, b, c] = sample(rng, U, 3)
      const name = `${topic} 비교 — ${a.name} vs ${b.name}`
      const pa = sample(rng, a[key], 2).map(link), pb = sample(rng, b[key], 2).map(link), pc = sample(rng, c[key], 1).map(link)
      docs.push({ path: `analysis/${name}.md`, content: `${fm(rng, { title: name, tags: ['analysis', 'cross-universe', 'fake-data', a.slug, b.slug], type: 'analysis' })}

# ${name}

## 질문
우리 프로젝트의 ${topic}을(를) 설계할 때 ${link(`${a.name} 세계관 개요`)}와 ${link(`${b.name} 세계관 개요`)} 중 어느 쪽 접근이 맞는가.

## ${a.name}
${pa.join(', ')} — ${paragraph(rng, a, a[key], 3)}

## ${b.name}
${pb.join(', ')} — ${paragraph(rng, b, b[key], 3)}

## 결론 (가상)
${pick(rng, ['전자', '후자', '절충안'])}. 보조 참고: ${pc.join(', ')} (${link(`${c.name} 세계관 개요`)}).

## 수치 비교 (가상)
${table(rng, [`${a.name} 기준값`, `${b.name} 기준값`, '우리 목표값'])}
` })
    }
  }
  // Project-level docs that tie the analyses together
  docs.push({ path: `analysis/세계관 레퍼런스 인덱스.md`, content: `${fm(rng, { title: '세계관 레퍼런스 인덱스', tags: ['analysis', 'hub', 'fake-data'], type: 'overview' })}

# 세계관 레퍼런스 인덱스

팀이 참고하는 ${U.length}개 세계관. 전부 **가상의 설계 노트**이며 실제 작품 설정과 다릅니다.

${U.map(u => `- ${link(`${u.name} 세계관 개요`)} — ${u.genre}, ${u.tone}`).join('\n')}

## 비교 분석
${docs.map(d => link(d.path.replace(/^analysis\//, '').replace(/\.md$/, ''))).join('\n')}
` })
  return docs
}

// ── Output ───────────────────────────────────────────────────────────────────

const docs = [...U.flatMap(universeDocs), ...crossDocs()]
console.log(`${docs.length} documents across ${U.length} universes`)

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
        if (row.deleted || !(row.path.startsWith('worlds/') || row.path.startsWith('analysis/'))) continue
        const r = await api(`/v1/file?path=${encodeURIComponent(row.path)}`, { method: 'DELETE' })
        if (r.ok || r.status === 404) removed++
      }
      if (page.next === null) break
      since = page.next
    }
    console.log(`wiped ${removed} seeded files`)
  }

  let created = 0, unchanged = 0, failed = 0
  const queue = [...docs]
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const r = await api(`/v1/file?path=${encodeURIComponent(d.path)}`, {
        method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-mtime': String(Date.now()) }, body: new TextEncoder().encode(d.content),
      })
      if (r.status === 201 || r.status === 200) created++
      else if (r.status === 204) unchanged++
      else { failed++; console.error(`${r.status} ${d.path}: ${(await r.text()).slice(0, 120)}`) }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  console.log(`uploaded to ${SERVER}: ${created} written, ${unchanged} unchanged, ${failed} failed`)
  if (failed) process.exit(1)
}
