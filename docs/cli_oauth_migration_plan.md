# Sandbox Map — Claude Code CLI OAuth 마이그레이션 계획

> 작성일: 2026-04-08  
> 목표: API 키 직접 호출 → Claude Code CLI session 기반 호출로 전환  
> 참조 구현: `c:\dev2\primmdev\primmdev_engine\governance\cli_runner.py`  
> 방식: 기존 프로젝트 복제 → 별도 프로젝트로 개발

---

## 1. 현재 구조 (AS-IS)

### AI 호출 지점 3곳

```
┌─ MCP 서버 (TypeScript) ──────────────────────────────┐
│  mcp/src/llm/client.ts → chat(), chatWithPersona()    │
│  mcp/src/llm/providers/anthropic.ts → fetch() 직접    │
│  mcp/src/llm/providers/openai.ts                      │
│  mcp/src/llm/providers/gemini.ts                      │
│  mcp/src/llm/providers/grok.ts                        │
│                                                        │
│  사용처: chat_persona, chat, edit_agent_refine,        │
│          debate_start                                  │
└────────────────────────────────────────────────────────┘

┌─ 슬랙봇 (Python) ────────────────────────────────────┐
│  bot/modules/claude_client.py → urllib 직접 HTTP 호출  │
│  → 쿼리 리라이팅, 멀티쿼리 분해, 웹 판단, 답변 생성   │
│  → self-review 2-pass                                  │
│                                                        │
│  bot/modules/multi_agent_rag.py → 서브에이전트 병렬    │
└────────────────────────────────────────────────────────┘

┌─ Electron 프론트엔드 (TypeScript) ───────────────────┐
│  src/services/llmClient.ts → Anthropic SDK 직접       │
│  → 슬랙봇 /ask 엔드포인트 답변 생성                   │
│  → LLM 리랭킹, 쿼리 확장                              │
└────────────────────────────────────────────────────────┘
```

### 문제점
- **4개 API 키 필요**: Anthropic, OpenAI, Gemini, Grok
- **비용 직접 과금**: 모든 호출이 API 키 기반
- **키 관리 부담**: mcp-config.json에 평문 저장

---

## 2. 목표 구조 (TO-BE)

```
┌─ 모든 AI 호출 ──────────────────────────────────────────┐
│                                                          │
│  claude CLI subprocess (persistent session)              │
│  --print --input-format stream-json                      │
│  --output-format stream-json --verbose                   │
│                                                          │
│  ┌──────────────┐    stdin (JSON)     ┌──────────────┐  │
│  │ Sandbox Map  │ ──────────────────→ │ claude CLI   │  │
│  │ (caller)     │ ←────────────────── │ (OAuth 인증) │  │
│  └──────────────┘    stdout (stream)  └──────────────┘  │
│                                                          │
│  인증: Claude Code OAuth (로그인 상태 자동 사용)         │
│  비용: Claude Code 플랜 크레딧                           │
│  세션: --resume으로 컨텍스트 유지                         │
└──────────────────────────────────────────────────────────┘
```

### 핵심 변경
- API 키 불필요 (OAuth 크레딧 사용)
- `claude` CLI를 subprocess로 호출
- stream-json 프로토콜로 실시간 스트리밍
- persistent session으로 다중 턴 유지

---

## 3. 프로젝트 복제 구조

```
c:\dev2\
├── Sandbox_Map/          ← 기존 (변경 없음)
└── Sandbox_Map_OAuth/    ← 복제본 (CLI OAuth 적용)
    ├── mcp/src/llm/
    │   ├── client.ts           ← 수정: CLI session 호출
    │   └── cli-session.ts      ← 신규: CLI subprocess 관리
    ├── bot/modules/
    │   ├── claude_client.py    ← 수정: CLI subprocess 호출
    │   └── cli_session.py      ← 신규: Python CLI session 관리
    ├── src/services/
    │   └── llmClient.ts        ← 수정: Electron에서 CLI 호출
    └── (나머지 동일)
```

---

## 4. 핵심 컴포넌트 설계

### 4.1 Python CLI Session Manager (`bot/modules/cli_session.py`)

primmdev의 `cli_runner.py` 참조하여 구현.

```python
"""
claude CLI persistent session manager.
API 키 없이 OAuth 크레딧으로 LLM 호출.
"""

class CLISession:
    """하나의 claude CLI 프로세스 = 하나의 세션"""
    
    def __init__(self, session_id: str, model: str = "claude-sonnet-4-6"):
        self.session_id = session_id
        self.model = model
        self.claude_session_id: str | None = None  # CLI가 반환하는 세션 ID
        self._proc: asyncio.subprocess.Process | None = None
    
    async def ensure_process(self) -> Process:
        """프로세스가 살아있으면 재사용, 죽었으면 새로 생성"""
        if self._proc and self._proc.returncode is None:
            return self._proc
        
        cmd = [
            "claude",
            "--print",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--model", self.model,
        ]
        if self.claude_session_id:
            cmd.extend(["--resume", self.claude_session_id])
        
        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=PIPE, stdout=PIPE, stderr=PIPE,
        )
        return self._proc
    
    async def send(self, message: str, system: str = "") -> CLIResult:
        """메시지 전송 → stream-json 응답 수집"""
        proc = await self.ensure_process()
        
        input_msg = json.dumps({
            "type": "user",
            "session_id": self.claude_session_id or str(uuid.uuid4()),
            "message": {"role": "user", "content": message},
        })
        
        proc.stdin.write((input_msg + "\n").encode())
        await proc.stdin.drain()
        
        # stdout에서 stream-json 이벤트 수집
        text_parts = []
        async for line in proc.stdout:
            event = json.loads(line)
            if event["type"] == "assistant":
                for block in event["message"]["content"]:
                    if block["type"] == "text":
                        text_parts.append(block["text"])
            elif event["type"] == "result":
                self.claude_session_id = event.get("session_id")
                return CLIResult(
                    text="".join(text_parts),
                    cost_usd=event.get("total_cost_usd", 0),
                    usage=event.get("usage", {}),
                )
    
    async def kill(self):
        """프로세스 종료"""
        if self._proc:
            self._proc.kill()
            self._proc = None


class CLISessionPool:
    """용도별 세션 풀 관리"""
    
    def __init__(self, max_sessions: int = 3):
        self.max_sessions = max_sessions
        self._sessions: dict[str, CLISession] = {}
    
    async def get(self, purpose: str, model: str = "claude-sonnet-4-6") -> CLISession:
        """용도별 세션 반환 (없으면 생성)"""
        if purpose not in self._sessions:
            self._sessions[purpose] = CLISession(purpose, model)
        return self._sessions[purpose]
    
    async def cleanup(self):
        """모든 세션 종료"""
        for s in self._sessions.values():
            await s.kill()
```

**용도별 세션 분리:**
| 세션 ID | 용도 | 모델 |
|---------|------|------|
| `rag_answer` | 슬랙봇 RAG 답변 생성 | sonnet |
| `query_rewrite` | 쿼리 리라이팅/분해 | haiku |
| `edit_agent` | 편집 에이전트 | sonnet |
| `persona_chat` | MCP 페르소나 채팅 | sonnet |

### 4.2 TypeScript CLI Session (`mcp/src/llm/cli-session.ts`)

MCP 서버 (Node.js)에서 동일 패턴으로 구현.

```typescript
import { spawn, ChildProcess } from 'child_process'

interface CLIResult {
  text: string
  costUsd: number
  usage: { input_tokens: number; output_tokens: number }
  sessionId?: string
}

class CLISession {
  private proc: ChildProcess | null = null
  private claudeSessionId: string | null = null
  
  constructor(
    private id: string,
    private model: string = 'claude-sonnet-4-6',
  ) {}
  
  async send(message: string): Promise<CLIResult> {
    if (!this.proc) await this.spawn()
    
    return new Promise((resolve, reject) => {
      const input = JSON.stringify({
        type: 'user',
        session_id: this.claudeSessionId ?? crypto.randomUUID(),
        message: { role: 'user', content: message },
      }) + '\n'
      
      this.proc!.stdin!.write(input)
      
      const textParts: string[] = []
      const handler = (data: Buffer) => {
        for (const line of data.toString().split('\n').filter(Boolean)) {
          const event = JSON.parse(line)
          if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) {
              if (block.type === 'text') textParts.push(block.text)
            }
          }
          if (event.type === 'result') {
            this.claudeSessionId = event.session_id
            this.proc!.stdout!.off('data', handler)
            resolve({
              text: textParts.join(''),
              costUsd: event.total_cost_usd ?? 0,
              usage: event.usage ?? {},
              sessionId: event.session_id,
            })
          }
        }
      }
      this.proc!.stdout!.on('data', handler)
    })
  }
  
  private async spawn() {
    const args = [
      '--print', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose',
      '--model', this.model,
    ]
    if (this.claudeSessionId) args.push('--resume', this.claudeSessionId)
    
    this.proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  }
}
```

### 4.3 기존 호출부 변경

#### MCP client.ts 변경

```typescript
// Before:
export async function chat(modelId, systemPrompt, messages, caller) {
  const provider = resolveProvider(modelId)
  const apiKey = getApiKey(provider)  // ← API 키 필요
  const streamFn = await getStreamFn(provider)
  await streamFn(apiKey, modelId, systemPrompt, messages, ...)
}

// After:
export async function chat(modelId, systemPrompt, messages, caller) {
  const session = await sessionPool.get(caller, modelId)
  const prompt = buildPrompt(systemPrompt, messages)  // system + history 합성
  const result = await session.send(prompt)
  return result.text
}
```

#### Python claude_client.py 변경

```python
# Before:
class ClaudeClient:
    def complete(self, system, user, max_tokens=1024):
        payload = {...}
        req = urllib.request.Request(API_URL, data=payload, headers={"x-api-key": self.api_key})
        ...

# After:
class ClaudeClient:
    def __init__(self, model="claude-sonnet-4-6"):
        self._session_pool = CLISessionPool()
    
    async def complete(self, system, user, max_tokens=1024):
        session = await self._session_pool.get("default", self.model)
        prompt = f"[시스템]\n{system}\n\n[사용자]\n{user}"
        result = await session.send(prompt)
        return result.text
```

---

## 5. 호환성 고려사항

### 5.1 동기→비동기 전환

현재 `ClaudeClient.complete()`는 **동기** 함수. CLI subprocess는 **비동기** 필수.

| 호출부 | 현재 | 변경 |
|--------|------|------|
| `bot.py` 쿼리 리라이팅 | `claude.complete(...)` 동기 | `await claude.complete(...)` 비동기 |
| `bot.py` 답변 생성 | 동기 | 비동기 |
| `multi_agent_rag.py` | 동기 | 비동기 (이미 async 구조) |
| MCP `client.ts` | 이미 async | 변경 없음 |

**해결**: 슬랙봇의 `_respond()` 메서드가 이미 async이므로, `ClaudeClient` 내부만 async로 전환하면 됨.

### 5.2 system prompt 전달 방식

Claude CLI stream-json은 `system` 필드를 별도로 받지 않음. message의 content에 포함해야 함.

```python
# 합성 방식
def build_prompt(system: str, user: str) -> str:
    return f"{system}\n\n---\n\n{user}"
```

또는 `--append-system-prompt` CLI 옵션 활용:
```
claude --append-system-prompt "페르소나 프롬프트..." --print ...
```

### 5.3 멀티 프로바이더 지원

현재 OpenAI/Gemini/Grok도 사용 중. CLI OAuth는 **Claude 전용**.

| 프로바이더 | 현재 | OAuth 후 |
|-----------|------|----------|
| Anthropic (Claude) | API 키 | **CLI OAuth** |
| OpenAI (GPT) | API 키 | API 키 유지 |
| Gemini | API 키 | API 키 유지 (임베딩용) |
| Grok | API 키 | API 키 유지 |

**결론**: `resolveProvider()` 에서 Claude 계열만 CLI session으로 라우팅, 나머지는 기존 방식 유지.

```typescript
export async function chat(modelId, systemPrompt, messages, caller) {
  const provider = resolveProvider(modelId)
  
  if (provider === 'anthropic') {
    // CLI OAuth 세션 사용
    const session = await sessionPool.get(caller, modelId)
    return await session.send(buildPrompt(systemPrompt, messages))
  }
  
  // 나머지는 기존 API 키 방식
  const apiKey = getApiKey(provider)
  const streamFn = await getStreamFn(provider)
  ...
}
```

### 5.4 동시성 제한

`claude` CLI는 동시 세션 수 제한이 있을 수 있음.

| 용도 | 동시성 | 대응 |
|------|--------|------|
| RAG 답변 | 1 (슬랙 요청 순차) | 단일 세션 |
| 쿼리 리라이팅 | 1 | 답변 세션 재사용 또는 별도 |
| 멀티에이전트 | 6~10 병렬 | **병목** — 순차 전환 필요 |
| 편집 에이전트 | 1 | 단일 세션 |

**멀티에이전트 RAG 대응**: 현재 6~10개 서브에이전트를 병렬 호출하는 구조 → CLI에서는 순차로 전환하거나, 세션 풀 크기를 3~4개로 제한하고 큐잉.

---

## 6. 구현 단계

### Phase 1: CLI Session 코어 (1~2일)

| 태스크 | 파일 | 설명 |
|--------|------|------|
| Python CLI session manager | `bot/modules/cli_session.py` | 신규 — primmdev 참조 |
| TypeScript CLI session | `mcp/src/llm/cli-session.ts` | 신규 |
| CLI 프로세스 헬스체크 | 양쪽 | stall 감지, 자동 재시작 |
| 기본 테스트 | `tests/` | send/receive 왕복 검증 |

### Phase 2: MCP 서버 전환 (1일)

| 태스크 | 파일 | 설명 |
|--------|------|------|
| client.ts 수정 | `mcp/src/llm/client.ts` | Claude 모델 → CLI session 라우팅 |
| anthropic.ts 폴백 유지 | `mcp/src/llm/providers/anthropic.ts` | API 키 있으면 기존 방식 폴백 |
| chat_persona 테스트 | — | E2E 검증 |

### Phase 3: 슬랙봇 전환 (1~2일)

| 태스크 | 파일 | 설명 |
|--------|------|------|
| ClaudeClient async 전환 | `bot/modules/claude_client.py` | CLI session 기반으로 교체 |
| bot.py 호출부 수정 | `bot/bot.py` | await 추가 |
| 멀티에이전트 순차화 | `bot/modules/multi_agent_rag.py` | 병렬→순차 또는 풀 큐잉 |
| 답변 품질 검증 | — | 기존 대비 동일 품질 확인 |

### Phase 4: Electron 전환 (1일)

| 태스크 | 파일 | 설명 |
|--------|------|------|
| llmClient.ts 수정 | `src/services/llmClient.ts` | CLI session 라우팅 |
| /ask 엔드포인트 검증 | — | 슬랙봇→Electron 경로 |

### Phase 5: 안정화 (1~2일)

| 태스크 | 설명 |
|--------|------|
| 세션 수명 관리 | 장시간 미사용 세션 자동 종료 |
| 에러 복구 | CLI 프로세스 크래시 시 자동 재시작 |
| 비용 추적 | CLI result의 cost_usd 집계 |
| API 키 폴백 | CLI 실패 시 기존 API 키로 자동 전환 |

---

## 7. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| CLI 동시 세션 제한 | 멀티에이전트 병렬 불가 | 세션 풀 + 큐잉, 순차 처리 |
| CLI 프로세스 불안정 | 답변 중 크래시 | watchdog + 자동 재시작 |
| 응답 지연 (프로세스 오버헤드) | 첫 호출 ~2초 추가 | persistent session으로 완화 |
| OAuth 토큰 만료 | 장시간 운영 시 인증 실패 | 프로세스 재생성으로 자동 갱신 |
| Claude Code 플랜 크레딧 한도 | 과다 사용 시 제한 | 비용 모니터링 + 알림 |
| system prompt 전달 제약 | 페르소나 품질 저하 | --append-system-prompt 활용 |

---

## 8. 폴백 전략

**이중 운영**: CLI OAuth 실패 시 자동으로 API 키 방식으로 전환.

```typescript
async function chat(modelId, system, messages, caller) {
  // 1순위: CLI OAuth
  try {
    const session = await sessionPool.get(caller, modelId)
    return await session.send(buildPrompt(system, messages))
  } catch (e) {
    log.warn("cli_session_failed", { error: e.message })
  }
  
  // 2순위: API 키 직접 (기존 방식)
  const apiKey = getApiKey('anthropic')
  if (apiKey) {
    const streamFn = await getStreamFn('anthropic')
    return await streamFn(apiKey, modelId, system, messages, ...)
  }
  
  throw new Error("No available LLM provider")
}
```

---

## 9. 예상 효과

| 항목 | Before | After |
|------|--------|-------|
| API 키 관리 | 4개 (Anthropic, OpenAI, Gemini, Grok) | 1~3개 (OpenAI, Gemini, Grok만) |
| Claude 과금 | API 직접 과금 | **Claude Code 플랜 포함** |
| 보안 | mcp-config.json 평문 저장 | OAuth (키 노출 없음) |
| 세션 컨텍스트 | 매 호출 독립 | **--resume으로 유지 가능** |
| 월 예상 비용 절감 | Claude API ~$30~50/월 | **$0 (플랜 내)** |

---

## 10. 작업 일정

| 단계 | 기간 | 마일스톤 |
|------|------|----------|
| Phase 1 — CLI 코어 | 1~2일 | Python + TS CLI session 동작 |
| Phase 2 — MCP 전환 | 1일 | chat_persona CLI 동작 |
| Phase 3 — 슬랙봇 전환 | 1~2일 | 슬랙 답변 CLI 동작 |
| Phase 4 — Electron 전환 | 1일 | /ask 엔드포인트 동작 |
| Phase 5 — 안정화 | 1~2일 | 폴백, 모니터링, 에러 복구 |
| **총 기간** | **5~8일** | |
