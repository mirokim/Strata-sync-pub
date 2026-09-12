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

        # Ordinal of the section within the document — material for a unique key when section_id is missing.
        # (Falling back to doc_id gives every section of the same document the same key,
        #  and idx restarts from 0 per section, so chunk IDs collide and upsert overwrites.)
        section_ordinal = doc_section_ordinal.get(doc_id, 0)
        doc_section_ordinal[doc_id] = section_ordinal + 1

        content = d.get("content", "").strip()
        if not content:
            continue

        raw_section_id = d.get("section_id")
        # Metadata keeps the existing fallback (doc_id), but ID generation uses the unique key
        section_id = raw_section_id or doc_id
        section_key = raw_section_id or f"{doc_id}#{section_ordinal}"

        sub_chunks = splitter.split_text(content)

        for idx, text in enumerate(sub_chunks):
            chunk_id = _chunk_id(doc_id, section_key, idx)
            if chunk_id in seen_ids:
                # Same input passed more than once — only one upsert target, so exclude from the count
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
