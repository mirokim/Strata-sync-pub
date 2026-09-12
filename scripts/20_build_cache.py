# -*- coding: utf-8 -*-
"""
20_build_cache.py — BGE-M3 local embeddings → Strata Sync .vector_cache_v6.json

Input : C:\\tmp\\embed_items.jsonl   (output of dump_embed_items.ts)
Output: C:\\dev2\\refined_vault\\.vector_cache_v6.json
Format: { version:6, chunkerVersion:2, entries:{ id:{embedding,docId,mtime} } }
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
ROUND = 6          # within float32 significant digits — reduces file size

def main():
    rows = [json.loads(l) for l in ITEMS.open(encoding="utf-8")]
    print(f"{len(rows):,} items to embed", flush=True)

    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL, dtype=torch.float16).to("cuda").eval()
    print(f"Model loaded | VRAM {torch.cuda.memory_allocated()/1e9:.2f}GB", flush=True)

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
                print(f"  {done:,}/{len(rows):,}  elapsed {el:.0f}s  remaining ~{eta:.0f}s", flush=True)

    V = np.vstack(vecs)
    dt = time.time() - t0
    print(f"\nEmbedding done {V.shape} | {dt:.1f}s | {len(rows)/dt:.1f} items/s", flush=True)
    print(f"Peak VRAM {torch.cuda.max_memory_allocated()/1e9:.2f}GB", flush=True)

    print("Writing cache file...", flush=True)
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
    print(f"Saved: {OUT}", flush=True)
    print(f"  {len(rows):,} entries | dim {V.shape[1]} | {mb:.1f}MB | written in {time.time()-t1:.1f}s", flush=True)

if __name__ == "__main__":
    main()
