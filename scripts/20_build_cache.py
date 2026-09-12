# -*- coding: utf-8 -*-
"""
20_build_cache.py — BGE-M3 로컬 임베딩 → Strata Sync .vector_cache_v6.json

입력 : C:\\tmp\\embed_items.jsonl   (dump_embed_items.ts 출력)
출력 : C:\\dev2\\refined_vault\\.vector_cache_v6.json
포맷 : { version:6, chunkerVersion:2, entries:{ id:{embedding,docId,mtime} } }
"""
import json, time
from pathlib import Path
import numpy as np
import torch
from transformers import AutoTokenizer, AutoModel

ITEMS = Path(r"C:\tmp\embed_items.jsonl")
OUT = Path(r"C:\dev2\refined_vault\.vector_cache_v6.json")
MODEL = "BAAI/bge-m3"
CHUNKER_VERSION = 5
MAXLEN = 4096
BATCH = 16
ROUND = 6          # float32 유효자릿수 내 — 파일 크기 절감

def main():
    rows = [json.loads(l) for l in ITEMS.open(encoding="utf-8")]
    print(f"임베딩 항목 {len(rows):,}개", flush=True)

    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL, dtype=torch.float16).to("cuda").eval()
    print(f"모델 로드 완료 | VRAM {torch.cuda.memory_allocated()/1e9:.2f}GB", flush=True)

    vecs = []
    t0 = time.time()
    with torch.inference_mode():
        for i in range(0, len(rows), BATCH):
            batch = [r["text"] for r in rows[i:i + BATCH]]
            enc = tok(batch, padding=True, truncation=True,
                      max_length=MAXLEN, return_tensors="pt").to("cuda")
            v = model(**enc).last_hidden_state[:, 0]
            v = torch.nn.functional.normalize(v, p=2, dim=1)
            vecs.append(v.float().cpu().numpy())
            if (i // BATCH) % 50 == 0:
                el = time.time() - t0
                done = i + len(batch)
                eta = (len(rows) - done) / max(done / max(el, .01), .01)
                print(f"  {done:,}/{len(rows):,}  경과 {el:.0f}s  잔여 ~{eta:.0f}s", flush=True)

    V = np.vstack(vecs)
    dt = time.time() - t0
    print(f"\n임베딩 완료 {V.shape} | {dt:.1f}s | 초당 {len(rows)/dt:.1f}개", flush=True)
    print(f"피크 VRAM {torch.cuda.max_memory_allocated()/1e9:.2f}GB", flush=True)

    print("캐시 파일 작성 중...", flush=True)
    t1 = time.time()
    with OUT.open("w", encoding="utf-8") as f:
        f.write('{"version":6,"chunkerVersion":%d,"provider":"local","dim":%d,"entries":{'
                % (CHUNKER_VERSION, V.shape[1]))
        for n, (r, vec) in enumerate(zip(rows, V)):
            if n:
                f.write(",")
            emb = ",".join(f"{x:.{ROUND}f}" for x in vec)
            f.write(json.dumps(r["id"], ensure_ascii=False))
            f.write(':{"embedding":[%s],"docId":%s,"mtime":%r}'
                    % (emb, json.dumps(r["docId"], ensure_ascii=False), r["mtime"]))
        f.write("}}")
    mb = OUT.stat().st_size / 1e6
    print(f"저장 완료: {OUT}", flush=True)
    print(f"  엔트리 {len(rows):,}개 | 차원 {V.shape[1]} | {mb:.1f}MB | 작성 {time.time()-t1:.1f}s", flush=True)

if __name__ == "__main__":
    main()
