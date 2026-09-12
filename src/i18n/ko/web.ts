// Korean translations — area: web. Key = the English string exactly as it appears in the UI.
const web: Record<string, string> = {
  // ConnectScreen.tsx
  'Enter the server address, e.g. https://strata-sync.<account>.workers.dev': '서버 주소를 입력하세요. 예: https://strata-sync.<account>.workers.dev',
  'Could not reach the server': '서버에 연결할 수 없음',
  "Your team's vault, in the browser": '브라우저로 만나는 팀 볼트',
  'Server': '서버',
  "The team's Cloudflare Worker. Ask whoever deployed it.": '팀의 Cloudflare Worker 주소. 배포한 사람에게 물어보세요.',
  'Opening Google…': 'Google 여는 중…',
  'Sign in with Google': 'Google로 로그인',
  'Any Google account works. Your name and e-mail are recorded on the documents you edit.': 'Google 계정이면 모두 가능. 편집한 문서에 이름과 이메일이 남음.',
  'Use a team token instead': '대신 팀 토큰 사용',
  'Team token': '팀 토큰',
  'shared team secret': '팀이 공유하는 비밀 값',
  'Stored in this browser only. The same token the desktop app and bots use.': '이 브라우저에만 저장. 데스크톱 앱과 봇이 쓰는 토큰과 동일.',
  'Your name': '이름',
  'shown on your edits and conflict copies': '편집 기록과 충돌 사본에 표시됩니다',
  'Sign in with Google instead': '대신 Google로 로그인',
  'Checking…': '확인 중…',
  'Connect with token': '토큰으로 연결',

  // WebRoot.tsx
  'Your session expired — sign in again.': '세션이 만료됨 — 다시 로그인하세요.',

  // auth.ts
  'client registration failed ({status})': '클라이언트 등록 실패 ({status})',
  'invalid server URL': '잘못된 서버 주소',
  'sign-in state mismatch — start again': '로그인 상태 불일치 — 다시 시도하세요',
  'sign-in took too long — start again': '로그인 시간이 초과됨 — 다시 시도하세요',
  'token endpoint answered {status}': '토큰 엔드포인트 응답 코드 {status}',

  // remoteClient.ts
  'session expired — sign in again': '세션이 만료됨 — 다시 로그인하세요',
  'team token rejected': '팀 토큰이 거부됨',
  'server unavailable': '서버를 사용할 수 없음',

  // remoteVault.ts
  'Invalid file path': '잘못된 파일 경로',
  'Sign in with Google to keep personal documents — the team token has no owner': '개인 문서를 유지하려면 Google로 로그인하세요 — 팀 토큰에는 소유자가 없음',
  'Your session expired — sign in again from Settings → Server': '세션이 만료됨 — 설정 → 서버에서 다시 로그인하세요',
  'The team token was rejected — reconnect in Settings → Server': '팀 토큰이 거부됨 — 설정 → 서버에서 다시 연결하세요',
  '{path} was changed by {author} — your version is kept as "{copy}"': '{path} 파일이 {author}에 의해 변경됨 — 내 버전은 "{copy}"로 보관됨',
  'someone else': '다른 사람',
  'File does not exist: {path}': '파일이 존재하지 않음: {path}',
  'Destination already exists: {path}': '대상이 이미 존재함: {path}',
  'Invalid filename': '잘못된 파일 이름',
  'Invalid path': '잘못된 경로',
  'Invalid folder path': '잘못된 폴더 경로',
  'server did not answer /health': '서버가 /health에 응답하지 않음',
}
export default web
