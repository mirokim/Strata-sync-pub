"""
rag_service.py — Phase 3

LangChain RecursiveCharacterTextSplitter-based chunking.
Converts incoming DocumentChunk objects into ChromaDB-ready flat dicts.
"""

from langchain_text_splitters import RecursiveCharacterTextSplitter
from backend.config import settings
import hashlib


def _chunk_id(doc_id: str, section_id: str, idx: int) -> str:
    """Generate a stable, deterministic chunk ID using MD5."""
    raw = f"{doc_id}::{section_id}::{idx}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


# Module-level singleton — avoids re-initialising LangChain splitter on every call
_splitter = RecursiveCharacterTextSplitter(
    chunk_size=settings.chunk_size,
    chunk_overlap=settings.chunk_overlap,
    separators=["\n\n", "\n", "。", ". ", " ", ""],
)


def prepare_chunks(documents: list) -> list[dict]:
    """
    Split each DocumentChunk into sub-chunks using LangChain's
    RecursiveCharacterTextSplitter, then flatten into ChromaDB-ready dicts.

    ChromaDB metadata values must be scalar (str | int | float | bool).
    Lists are joined as comma-separated strings.

    Args:
        documents: list of DocumentChunk Pydantic models (or dicts with same fields)

    Returns:
        list of dicts with keys: id, content, doc_id, filename, section_id,
        heading, speaker, tags (comma-sep string)
    """
    splitter = _splitter

    output: list[dict] = []
    seen_ids: set[str] = set()
    doc_section_ordinal: dict[str, int] = {}

    for doc in documents:
        # Support both Pydantic models and plain dicts
        if hasattr(doc, "model_dump"):
            d = doc.model_dump()
        else:
            d = dict(doc)

        doc_id = d.get("doc_id", "")

        # 문서 내 섹션 등장 순번 — section_id 가 없는 섹션의 고유 키 재료.
        # (doc_id 로 폴백하면 같은 문서의 모든 섹션이 동일 키가 되고,
        #  idx 는 섹션마다 0부터 다시 시작하므로 청크 ID가 충돌해 upsert 가 덮어쓴다.)
        section_ordinal = doc_section_ordinal.get(doc_id, 0)
        doc_section_ordinal[doc_id] = section_ordinal + 1

        content = d.get("content", "").strip()
        if not content:
            continue

        raw_section_id = d.get("section_id")
        # 메타데이터는 기존 폴백(doc_id)을 유지하되, ID 생성에는 고유 키를 사용
        section_id = raw_section_id or doc_id
        section_key = raw_section_id or f"{doc_id}#{section_ordinal}"

        sub_chunks = splitter.split_text(content)

        for idx, text in enumerate(sub_chunks):
            chunk_id = _chunk_id(doc_id, section_key, idx)
            if chunk_id in seen_ids:
                # 동일 입력이 중복 전달된 경우 — upsert 대상은 1건뿐이므로 집계에서 제외
                continue
            seen_ids.add(chunk_id)
            output.append(
                {
                    "id": chunk_id,
                    "content": text,
                    "doc_id": doc_id,
                    "filename": d["filename"],
                    "section_id": section_id,
                    "heading": d.get("heading") or "",
                    "speaker": d.get("speaker", "unknown"),
                    # ChromaDB metadata must be scalar — flatten list to string
                    "tags": ",".join(d.get("tags", [])),
                }
            )

    return output
