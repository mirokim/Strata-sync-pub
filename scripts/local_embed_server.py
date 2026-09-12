# -*- coding: utf-8 -*-
"""
local_embed_server.py — BGE-M3 local embedding server (fully offline)

Lets Strata Sync call this server instead of the Gemini API
so internal documents never leave the premises.

Run:   python scripts/local_embed_server.py
Check: curl http://127.0.0.1:8077/health

Endpoints
  GET  /health          -> {"status":"ok","model":...,"dim":1024,"device":"cuda"}
  POST /embed           -> {"texts":[...], "type":"query"|"document"} => {"embeddings":[[...]]}
"""
import sys, time
from typing import List, Literal

import torch
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModel

MODEL_ID = "BAAI/bge-m3"
HOST, PORT = "127.0.0.1", 8077
# BGE-M3 supports up to 8192 tokens. Korean is ~1.2-1.4 chars per token, so 1024 tokens
# is only ~1,200-1,400 effective chars and the tail of long documents was cut off entirely.
# Peak VRAM is around 1.5GB (of 24GB), so raising to 4096 leaves plenty of headroom.
MAXLEN = 4096
BATCH = 16

print(f"[embed] Loading model: {MODEL_ID}", flush=True)
_t0 = time.time()
_device = "cuda" if torch.cuda.is_available() else "cpu"
_tok = AutoTokenizer.from_pretrained(MODEL_ID)
_model = AutoModel.from_pretrained(
    MODEL_ID, dtype=torch.float16 if _device == "cuda" else torch.float32
).to(_device).eval()
_DIM = int(_model.config.hidden_size)
print(f"[embed] Ready in {time.time()-_t0:.1f}s | device={_device} dim={_DIM}", flush=True)

app = FastAPI(title="Strata Sync Local Embeddings")


class EmbedRequest(BaseModel):
    texts: List[str]
    type: Literal["query", "document"] = "document"


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID, "dim": _DIM, "device": _device}


@torch.inference_mode()
def _encode(texts: List[str]) -> List[List[float]]:
    out: List[List[float]] = []
    for i in range(0, len(texts), BATCH):
        chunk = texts[i:i + BATCH]
        enc = _tok(chunk, padding=True, truncation=True,
                   max_length=MAXLEN, return_tensors="pt").to(_device)
        v = _model(**enc).last_hidden_state[:, 0]          # CLS pooling
        v = torch.nn.functional.normalize(v, p=2, dim=1)   # L2 normalization
        out.extend(v.float().cpu().tolist())
    return out


@app.post("/embed")
def embed(req: EmbedRequest):
    # BGE-M3 needs no query/document prefix (symmetric training)
    if not req.texts:
        return {"embeddings": []}
    return {"embeddings": _encode(req.texts)}


if __name__ == "__main__":
    print(f"[embed] Listening on http://{HOST}:{PORT}", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
