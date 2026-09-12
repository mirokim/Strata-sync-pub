# -*- coding: utf-8 -*-
"""
40_eval_retrieval.py — quantitative evaluation of vector search quality

Replicates the app's fullVectorSearch path using .vector_cache_v6.json + the local embedding server
and measures Recall@5 / Recall@10 / hallucination separation against a golden set.

Run: python scripts/40_eval_retrieval.py
"""
import json, re, urllib.request
from pathlib import Path
import numpy as np

CACHE = Path(r"C:\dev2\refined_vault\.vector_cache_v6.json")
URL = "http://127.0.0.1:8077"

# (query, expected docId regex | None = no correct answer)
CASES = [
    ("루모 전지가 뭐야?",            r"용어의_정의"),
    ("루모 결정은 어떻게 만들어지나",   r"용어의_정의"),
    ("빌더와 루울의 차이",            r"용어의_정의|직업"),
    ("엔지니어는 어떤 직업이야",       r"용어의_정의|직업"),
    ("에녹은 어떤 국가인가",          r"국가|에녹"),
    ("노든은 어떤 나라야",            r"국가|노든"),
    ("도문 행성 설정",               r"도문|세계관"),
    ("캐릭터G 캐릭터 스킬",            r"캐릭터G"),
    ("캐릭터A 캐릭터 설정",            r"캐릭터A"),
    ("점령전 규칙",                  r"점령전"),
    ("이사장님이 캐릭터팀에 준 피드백", r"캐릭터팀_이사장님_피드백"),
    ("아스가르드 왕국의 역사",         None),
    ("드래곤 라이더 직업 스킬 트리",    None),
]

def embed(texts):
    body = json.dumps({"texts": texts, "type": "query"}).encode()
    req = urllib.request.Request(f"{URL}/embed", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return np.array(json.load(r)["embeddings"], dtype=np.float32)

def main():
    rec = json.loads(CACHE.read_text(encoding="utf-8"))
    docids, mat = [], []
    for _sid, e in rec["entries"].items():
        docids.append(e["docId"]); mat.append(e["embedding"])
    M = np.asarray(mat, dtype=np.float32)
    print(f"Cache v{rec['version']} chunker{rec['chunkerVersion']} "
          f"provider={rec.get('provider')} dim={rec.get('dim')} / {len(docids):,} entries")

    Q = embed([q for q, _ in CASES])

    def top_docs(qv, k):
        s = M @ qv
        out, seen = [], set()
        for i in np.argsort(-s):
            d = docids[i]
            if d in seen:
                continue
            seen.add(d); out.append((d, float(s[i])))
            if len(out) >= k:
                break
        return out

    hit5 = hit10 = npos = 0
    pos_top, neg_top = [], []
    print(f"\n{'Query':<32}{'@5':>5}{'@10':>5}{'Top score':>9}  Top-1 document")
    print("-" * 100)
    for (q, pat), qv in zip(CASES, Q):
        top = top_docs(qv, 10)
        best = top[0]
        if pat is None:
            neg_top.append(best[1])
            print(f"{q:<32}{'—':>5}{'—':>5}{best[1]:>9.3f}  (no answer) {best[0][:40]}")
            continue
        npos += 1
        pos_top.append(best[1])
        r5 = any(re.search(pat, d) for d, _ in top[:5])
        r10 = any(re.search(pat, d) for d, _ in top)
        hit5 += r5; hit10 += r10
        print(f"{q:<32}{('O' if r5 else 'X'):>5}{('O' if r10 else 'X'):>5}"
              f"{best[1]:>9.3f}  {best[0][:46]}")
    print("-" * 100)
    print(f"Recall@5  {hit5}/{npos} ({hit5/npos:.0%})    Recall@10 {hit10}/{npos} ({hit10/npos:.0%})")
    print(f"Mean top score with answer    {np.mean(pos_top):.3f} (min {min(pos_top):.3f})")
    print(f"Mean top score without answer {np.mean(neg_top):.3f} (max {max(neg_top):.3f})")
    gap = min(pos_top) - max(neg_top)
    print(f"Separation margin {gap:+.3f}  → {'separable by threshold' if gap > 0 else 'overlap (threshold alone cannot block hallucinations)'}")

if __name__ == "__main__":
    main()
