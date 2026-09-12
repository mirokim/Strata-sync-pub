# -*- coding: utf-8 -*-
"""
30_verify.py — 앱이 할 일을 그대로 재현해 캐시가 실제로 동작하는지 검증

1) .vector_cache_v6.json 로드 (앱과 동일 파싱)
2) 로컬 임베딩 서버로 쿼리 임베딩 (앱과 동일 경로 + queryPrefix)
3) 코사인 유사도 → 문서 단위 max 집계 (앱 searchVector 와 동일)
"""
import json, time, urllib.request
from pathlib import Path
import numpy as np

CACHE = Path(r"C:\dev2\refined_vault\.vector_cache_v6.json")
URL = "http://127.0.0.1:8077"

def query_prefix(q):           # vectorEmbedIndex.ts queryText 와 동일 (접두사 제거됨)
    return q

def embed(texts):
    body = json.dumps({"texts": texts, "type": "query"}).encode()
    req = urllib.request.Request(f"{URL}/embed", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return np.array(json.load(r)["embeddings"], dtype=np.float32)

print("캐시 로드 중...", flush=True)
t0 = time.time()
rec = json.loads(CACHE.read_text(encoding="utf-8"))
assert rec["version"] == 6, rec["version"]
ids, docids, mat = [], [], []
for sid, e in rec["entries"].items():
    ids.append(sid); docids.append(e["docId"]); mat.append(e["embedding"])
M = np.asarray(mat, dtype=np.float32)
print(f"  version={rec['version']} chunkerVersion={rec['chunkerVersion']}")
print(f"  엔트리 {len(ids):,}개 / 차원 {M.shape[1]} / 로드 {time.time()-t0:.1f}s")

with urllib.request.urlopen(f"{URL}/health", timeout=10) as r:
    h = json.load(r)
print(f"  서버: {h['model']} dim={h['dim']} device={h['device']}")
assert h["dim"] == M.shape[1], f"차원 불일치! 캐시 {M.shape[1]} vs 서버 {h['dim']}"
print("  ✓ 차원 일치\n")

QUERIES = [
    "루모 전지가 뭐야?",
    "에녹은 어떤 국가인가",
    "빌더와 루울의 차이",
    "다이잔 캐릭터 스킬 알려줘",
    "점령전 규칙이 어떻게 되나",
    "이사장님이 캐릭터팀에 준 피드백",
]
Q = embed([query_prefix(q) for q in QUERIES])

for q, qv in zip(QUERIES, Q):
    sims = M @ qv                      # 정규화돼 있으므로 내적 = 코사인
    best = {}
    for i in np.argsort(-sims)[:200]:
        d = docids[i]
        if d not in best:
            best[d] = float(sims[i])
        if len(best) >= 5:
            break
    print(f"Q. {q}")
    for d, s in list(best.items())[:4]:
        print(f"    {s:.3f}  {d[:78]}")
    print()
