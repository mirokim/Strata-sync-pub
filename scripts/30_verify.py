# -*- coding: utf-8 -*-
"""
30_verify.py — replicate exactly what the app does to verify the cache actually works

1) Load .vector_cache_v6.json (same parsing as the app)
2) Embed queries via the local embedding server (same path as the app + queryPrefix)
3) Cosine similarity → per-document max aggregation (same as the app's searchVector)
"""
import json, time, urllib.request
from pathlib import Path
import numpy as np

CACHE = Path(r"C:\dev2\refined_vault\.vector_cache_v6.json")
URL = "http://127.0.0.1:8077"

def query_prefix(q):           # same as vectorEmbedIndex.ts queryText (prefix removed)
    return q

def embed(texts):
    body = json.dumps({"texts": texts, "type": "query"}).encode()
    req = urllib.request.Request(f"{URL}/embed", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return np.array(json.load(r)["embeddings"], dtype=np.float32)

print("Loading cache...", flush=True)
t0 = time.time()
rec = json.loads(CACHE.read_text(encoding="utf-8"))
assert rec["version"] == 6, rec["version"]
ids, docids, mat = [], [], []
for sid, e in rec["entries"].items():
    ids.append(sid); docids.append(e["docId"]); mat.append(e["embedding"])
M = np.asarray(mat, dtype=np.float32)
print(f"  version={rec['version']} chunkerVersion={rec['chunkerVersion']}")
print(f"  {len(ids):,} entries / dim {M.shape[1]} / loaded in {time.time()-t0:.1f}s")

with urllib.request.urlopen(f"{URL}/health", timeout=10) as r:
    h = json.load(r)
print(f"  Server: {h['model']} dim={h['dim']} device={h['device']}")
assert h["dim"] == M.shape[1], f"Dimension mismatch! cache {M.shape[1]} vs server {h['dim']}"
print("  ✓ Dimensions match\n")

QUERIES = [
    "루모 전지가 뭐야?",
    "에녹은 어떤 국가인가",
    "빌더와 루울의 차이",
    "캐릭터G 캐릭터 스킬 알려줘",
    "점령전 규칙이 어떻게 되나",
    "이사장님이 캐릭터팀에 준 피드백",
]
Q = embed([query_prefix(q) for q in QUERIES])

for q, qv in zip(QUERIES, Q):
    sims = M @ qv                      # normalized, so dot product = cosine
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
