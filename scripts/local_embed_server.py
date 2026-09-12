# -*- coding: utf-8 -*-
"""
local_embed_server.py — BGE-M3 로컬 임베딩 서버 (완전 오프라인)

Strata Sync 이 Gemini API 대신 이 서버를 호출하도록 하여
사내 문서가 외부로 나가지 않게 합니다.

실행:  python scripts/local_embed_server.py
확인:  curl http://127.0.0.1:8077/health

엔드포인트
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
# BGE-M3 는 8192 토큰까지 지원한다. 한국어는 1토큰≈1.2~1.4자라 1024 토큰이면
# 실효 1,200~1,400자밖에 안 되어 긴 문서의 뒷부분이 통째로 잘렸다.
# 피크 VRAM 이 1.5GB(24GB 중) 수준이라 4096 으로 올려도 여유가 충분하다.
MAXLEN = 4096
BATCH = 16

print(f"[embed] 모델 로드: {MODEL_ID}", flush=True)
_t0 = time.time()
_device = "cuda" if torch.cuda.is_available() else "cpu"
_tok = AutoTokenizer.from_pretrained(MODEL_ID)
_model = AutoModel.from_pretrained(
    MODEL_ID, dtype=torch.float16 if _device == "cuda" else torch.float32
).to(_device).eval()
_DIM = int(_model.config.hidden_size)
print(f"[embed] 준비 완료 {time.time()-_t0:.1f}s | device={_device} dim={_DIM}", flush=True)

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
        v = _model(**enc).last_hidden_state[:, 0]          # CLS 풀링
        v = torch.nn.functional.normalize(v, p=2, dim=1)   # L2 정규화
        out.extend(v.float().cpu().tolist())
    return out


@app.post("/embed")
def embed(req: EmbedRequest):
    # BGE-M3 는 query/document 프리픽스가 불필요 (대칭 학습)
    if not req.texts:
        return {"embeddings": []}
    return {"embeddings": _encode(req.texts)}


if __name__ == "__main__":
    print(f"[embed] http://{HOST}:{PORT} 대기 중", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
