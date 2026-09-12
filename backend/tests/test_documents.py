"""
test_documents.py — Phase 1-3

Tests for /docs/* endpoints (index, clear, search, stats).
"""

import pytest


# ── /docs/index ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_index_returns_indexed_count(client, sample_chunks):
    """POST /docs/index returns the number of sub-chunks created."""
    response = await client.post("/docs/index", json={"documents": sample_chunks})
    assert response.status_code == 200
    data = response.json()
    assert "indexed" in data
    # Each chunk may be further split by LangChain, so >= number of input docs
    assert data["indexed"] >= len(sample_chunks)


@pytest.mark.asyncio
async def test_index_count_reflects_stored_chunks(client):
    """indexed 는 실제 저장된 청크 수여야 한다 (중복 ID 는 1건으로 집계)."""
    doc = {
        "doc_id": "dup_001",
        "filename": "dup.md",
        "section_id": "dup_001_s1",
        "heading": "중복",
        "speaker": "chief_director",
        "content": "동일한 내용입니다.",
        "tags": [],
    }
    response = await client.post("/docs/index", json={"documents": [doc, dict(doc)]})
    assert response.status_code == 200
    stats = await client.get("/docs/stats")
    assert response.json()["indexed"] == stats.json()["chunk_count"]


@pytest.mark.asyncio
async def test_index_empty_request(client):
    """POST /docs/index with empty documents list returns indexed=0."""
    response = await client.post("/docs/index", json={"documents": []})
    assert response.status_code == 200
    assert response.json()["indexed"] == 0


@pytest.mark.asyncio
async def test_index_is_idempotent(client, sample_chunks):
    """Indexing the same documents twice does not duplicate chunks."""
    await client.post("/docs/index", json={"documents": sample_chunks})
    r2 = await client.post("/docs/index", json={"documents": sample_chunks})
    assert r2.status_code == 200
    # upsert: chunk count should remain the same after second index
    stats = await client.get("/docs/stats")
    count_after_second = stats.json()["chunk_count"]
    assert count_after_second >= len(sample_chunks)


# ── /docs/clear ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_clear_removes_all_documents(client, sample_chunks):
    """DELETE /docs/clear removes all indexed chunks."""
    await client.post("/docs/index", json={"documents": sample_chunks})
    response = await client.delete("/docs/clear")
    assert response.status_code == 200
    assert response.json()["cleared"] is True


@pytest.mark.asyncio
async def test_clear_empty_collection(client):
    """DELETE /docs/clear on an empty collection returns cleared=True."""
    response = await client.delete("/docs/clear")
    assert response.status_code == 200
    assert response.json()["cleared"] is True


@pytest.mark.asyncio
async def test_requests_still_work_after_clear(client, sample_chunks):
    """clear() 후에도 stats/index/search 가 동작해야 한다.

    _ensure_ready 가 _client 만 보고 조기 반환하면 _collection 이 None 인 채로
    남아 이후 모든 요청이 500 이 되고 재시작 전까지 복구되지 않는다.
    """
    await client.post("/docs/index", json={"documents": sample_chunks})
    assert (await client.delete("/docs/clear")).status_code == 200

    stats = await client.get("/docs/stats")
    assert stats.status_code == 200
    assert stats.json()["chunk_count"] == 0

    reindex = await client.post("/docs/index", json={"documents": sample_chunks})
    assert reindex.status_code == 200
    assert reindex.json()["indexed"] >= len(sample_chunks)

    search = await client.post("/docs/search", json={"query": "아트", "top_k": 3})
    assert search.status_code == 200


# ── /docs/search ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_returns_results(client, sample_chunks):
    """POST /docs/search returns relevant results after indexing."""
    await client.post("/docs/index", json={"documents": sample_chunks})

    response = await client.post(
        "/docs/search", json={"query": "아트 비주얼 스타일", "top_k": 3}
    )
    assert response.status_code == 200
    data = response.json()
    assert "results" in data
    assert "query" in data
    assert data["query"] == "아트 비주얼 스타일"
    # Should find at least the art chunk
    assert len(data["results"]) >= 1


@pytest.mark.asyncio
async def test_search_result_shape(client, sample_chunks):
    """Each search result contains all required fields."""
    await client.post("/docs/index", json={"documents": sample_chunks})
    response = await client.post(
        "/docs/search", json={"query": "엔진 렌더링", "top_k": 1}
    )
    data = response.json()
    assert len(data["results"]) >= 1
    result = data["results"][0]

    required_fields = {"doc_id", "filename", "speaker", "content", "score", "tags"}
    assert required_fields.issubset(result.keys())
    assert isinstance(result["score"], float)
    assert 0.0 <= result["score"] <= 1.0


@pytest.mark.asyncio
async def test_search_empty_collection(client):
    """POST /docs/search on empty collection returns empty results (no crash)."""
    response = await client.post(
        "/docs/search", json={"query": "아무 쿼리", "top_k": 3}
    )
    assert response.status_code == 200
    assert response.json()["results"] == []
