# -*- coding: utf-8 -*-
"""
40_eval_retrieval.py — 벡터 검색 품질 정량 평가

.vector_cache_v6.json + 로컬 임베딩 서버로 앱의 fullVectorSearch 경로를 재현해
골든셋에 대한 Recall@5 / Recall@10 / 환각 분리도를 측정한다.

실행: python scripts/40_eval_retrieval.py
"""
import json, re, urllib.request
from pathlib import Path
import numpy as np

CACHE = Path(r"C:\dev2\refined_vault\.vector_cache_v6.json")
URL = "http://127.0.0.1:8077"

# (질의, 정답 docId 정규식 | None=정답 없음)
CASES = [
    ("루모 전지가 뭐야?",            r"용어의_정의"),
    ("루모 결정은 어떻게 만들어지나",   r"용어의_정의"),
    ("빌더와 루울의 차이",            r"용어의_정의|직업"),
    ("엔지니어는 어떤 직업이야",       r"용어의_정의|직업"),
    ("에녹은 어떤 국가인가",          r"국가|에녹"),
    ("노든은 어떤 나라야",            r"국가|노든"),
    ("도문 행성 설정",               r"도문|세계관"),
    ("다이잔 캐릭터 스킬",            r"다이잔"),
    ("스칼렛 캐릭터 설정",            r"스칼렛"),
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
    print(f"캐시 v{rec['version']} chunker{rec['chunkerVersion']} "
          f"provider={rec.get('provider')} dim={rec.get('dim')} / 엔트리 {len(docids):,}")

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
    print(f"\n{'질의':<32}{'@5':>5}{'@10':>5}{'최고점':>9}  1위 문서")
    print("-" * 100)
    for (q, pat), qv in zip(CASES, Q):
        top = top_docs(qv, 10)
        best = top[0]
        if pat is None:
            neg_top.append(best[1])
            print(f"{q:<32}{'—':>5}{'—':>5}{best[1]:>9.3f}  (정답없음) {best[0][:40]}")
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
    print(f"정답있음 최고점 평균 {np.mean(pos_top):.3f} (최저 {min(pos_top):.3f})")
    print(f"정답없음 최고점 평균 {np.mean(neg_top):.3f} (최고 {max(neg_top):.3f})")
    gap = min(pos_top) - max(neg_top)
    print(f"분리 여유 {gap:+.3f}  → {'임계값으로 분리 가능' if gap > 0 else '겹침 (임계값 단독으로는 환각 차단 불가)'}")

if __name__ == "__main__":
    main()
