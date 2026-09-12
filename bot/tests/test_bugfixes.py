"""
tests/test_bugfixes.py — 조사에서 확인된 버그들의 회귀 테스트

실행: python -m pytest bot/tests/ -v
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))

import modules.multi_agent_rag as mar
from modules.keyword_store import KeywordStore, KeywordStoreError
from modules.mirofish_handler import match_vs_topics
from modules.rag_simple import _tokenize
from modules.slack_formatter import md_to_slack
from modules.vault_scanner import scan_vault


# ── vault_scanner: dot 디렉터리 아래 볼트 ──────────────────────────────────────

class TestScanVaultUnderDotDir(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _write(self, rel: str, text: str = "# 제목\n본문"):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    def test_vault_under_dot_directory_is_scanned(self):
        """볼트 루트가 dot 디렉터리 아래여도 문서가 스캔돼야 한다."""
        self._write(".notes/vault/doc1.md")
        self._write(".notes/vault/sub/doc2.md")
        docs = scan_vault(str(self.root / ".notes" / "vault"))
        self.assertEqual({d.stem for d in docs}, {"doc1", "doc2"})

    def test_hidden_folder_inside_vault_still_excluded(self):
        """볼트 내부의 .obsidian 등 숨김 폴더는 여전히 제외돼야 한다."""
        self._write("vault/keep.md")
        self._write("vault/.obsidian/skip.md")
        docs = scan_vault(str(self.root / "vault"))
        self.assertEqual({d.stem for d in docs}, {"keep"})

    def test_parent_resolved_is_precomputed(self):
        self._write("vault/doc.md")
        docs = scan_vault(str(self.root / "vault"))
        self.assertEqual(
            docs[0].parent_resolved, str((self.root / "vault").resolve())
        )


# ── keyword_store: 로드 실패 시 저장 차단 ─────────────────────────────────────

class TestKeywordStoreLoadFailure(unittest.TestCase):
    def setUp(self):
        self.vault = Path(tempfile.mkdtemp())
        self.rel = "keyword_index.json"

    def tearDown(self):
        shutil.rmtree(self.vault, ignore_errors=True)

    def _store(self):
        return KeywordStore(str(self.vault), self.rel)

    def test_corrupt_file_raises_on_load(self):
        (self.vault / self.rel).write_text("{ broken json", encoding="utf-8")
        with self.assertRaises(KeywordStoreError):
            self._store().load()

    def test_save_blocked_after_failed_load(self):
        """로드 실패 후 save() 가 기존 인덱스를 덮어쓰면 안 된다."""
        path = self.vault / self.rel
        path.write_text("{ broken json", encoding="utf-8")
        store = self._store()
        with self.assertRaises(KeywordStoreError):
            store.load()
        store.upsert("신규", "hub")
        with self.assertRaises(KeywordStoreError):
            store.save()
        # 원본 파일이 그대로 남아 있어야 한다
        self.assertEqual(path.read_text(encoding="utf-8"), "{ broken json")

    def test_save_blocked_without_load(self):
        store = self._store()
        store.upsert("신규", "hub")
        with self.assertRaises(KeywordStoreError):
            store.save()

    def test_missing_file_allows_new_store(self):
        store = self._store()
        self.assertFalse(store.load())
        store.upsert("신규", "hub")
        store.save()
        self.assertEqual(self._store().load(), True)

    def test_roundtrip_preserves_existing_keywords(self):
        store = self._store()
        store.load()
        store.upsert("기존", "hub1")
        store.save()

        store2 = self._store()
        store2.load()
        store2.upsert("추가", "hub2")
        store2.save()

        store3 = self._store()
        store3.load()
        self.assertEqual(set(store3.get_keywords()), {"기존", "추가"})


# ── slack_formatter: 이미지 렌더 ──────────────────────────────────────────────

class TestSlackImageFormat(unittest.TestCase):
    def test_image_has_no_stray_bang(self):
        out = md_to_slack("![캐릭터](https://x.test/a.png)")
        self.assertEqual(out, "<https://x.test/a.png|캐릭터>")
        self.assertNotIn("!<", out)

    def test_image_without_alt(self):
        self.assertEqual(md_to_slack("![](https://x.test/a.png)"), "<https://x.test/a.png>")

    def test_plain_link_unchanged(self):
        self.assertEqual(md_to_slack("[문서](https://x.test/d)"), "<https://x.test/d|문서>")


# ── rag_simple: 토크나이저 구분자 ─────────────────────────────────────────────

class TestTokenizerPunctuation(unittest.TestCase):
    def test_question_mark_is_separator(self):
        self.assertIn("밸런스", _tokenize("밸런스는?"))

    def test_colon_and_semicolon(self):
        tokens = _tokenize("사운드: bgm; 효과음!")
        for t in ("사운드", "bgm", "효과음"):
            self.assertIn(t, tokens)


# ── mirofish_handler: vs / 대비 매칭 ──────────────────────────────────────────

class TestMiroFishVsMatching(unittest.TestCase):
    def test_vs_returns_both_operands(self):
        self.assertEqual(match_vs_topics("신규 캐릭터 vs 기존 캐릭터"), ("신규 캐릭터", "기존 캐릭터"))

    def test_wa_bigyo(self):
        self.assertEqual(match_vs_topics("A안 과 B안 비교"), ("A안", "B안"))

    def test_daebi_alone_does_not_match(self):
        """'비용 대비 효과' 같은 평범한 한국어는 A/B 모드로 오인하면 안 된다."""
        self.assertIsNone(match_vs_topics("비용 대비 효과 시뮬레이션"))

    def test_daebi_with_comparison_cue_matches(self):
        self.assertEqual(
            match_vs_topics("신규 모드 대비 기존 모드 비교"),
            ("신규 모드", "기존 모드"),
        )

    def test_no_operand_returns_none(self):
        self.assertIsNone(match_vs_topics("시뮬레이션 해줘"))


# ── multi_agent_rag: 체크포인트 문서 id 매칭 ──────────────────────────────────

def _doc(stem: str, score: float = 5.0) -> dict:
    return {
        "title": stem, "stem": stem, "body": "본문", "score": score,
        "date": "2026-01-01", "tags": [], "doc_type": "reference",
    }


class TestCheckpointDocKey(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.orig_dir = mar._CHECKPOINT_DIR
        mar._CHECKPOINT_DIR = self.tmp_dir

    def tearDown(self):
        mar._CHECKPOINT_DIR = self.orig_dir
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_checkpoint_follows_document_not_position(self):
        """hotness 재정렬로 순서가 바뀌어도 캐시된 분석이 원래 문서에 붙어야 한다."""
        doc_a, doc_b = _doc("alpha"), _doc("beta")
        client = MagicMock()

        def responder(_system, user, **_kw):
            if "alpha" in user:
                return '{"score": 9, "summary": "알파 요약", "key_points": []}'
            return '{"score": 1, "summary": "베타 요약", "key_points": []}'

        # 1차 실행 — 두 문서 모두 분석되어 체크포인트 저장
        client.complete.side_effect = responder
        first = mar.run_sub_agents(client, "질문", [doc_a, doc_b])
        self.assertEqual({a["doc"]["stem"]: a["summary"] for a in first},
                         {"alpha": "알파 요약", "beta": "베타 요약"})

        # 2차 실행 — 순서를 뒤집는다. 전부 체크포인트에서 복원돼야 하고,
        # 위치 인덱스로 매칭하면 요약이 서로 뒤바뀐다.
        client.complete.side_effect = None
        client.complete.return_value = '{"score": 0, "summary": "재분석", "key_points": []}'
        calls_before = client.complete.call_count
        second = mar.run_sub_agents(client, "질문", [doc_b, doc_a])
        by_stem = {a["doc"]["stem"]: a for a in second}
        self.assertEqual(by_stem["alpha"]["summary"], "알파 요약")
        self.assertEqual(by_stem["beta"]["summary"], "베타 요약")
        self.assertEqual(client.complete.call_count, calls_before)  # 재분석 없음


# ── bot: 짧은 한국어 키워드 유효성 ────────────────────────────────────────────

class TestIsValidSearchQuery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import bot as bot_module
        cls.fn = staticmethod(bot_module._is_valid_search_query)

    def test_short_core_keywords_accepted(self):
        for kw in ("밸런스", "캐릭터", "사운드", "GDD", "루모", "에녹", "다이잔"):
            self.assertTrue(self.fn(kw), kw)

    def test_single_syllable_rejected(self):
        self.assertFalse(self.fn("맵"))

    def test_conversational_response_rejected(self):
        self.assertFalse(self.fn("죄송합니다, 내용이 없습니다."))

    def test_too_long_rejected(self):
        self.assertFalse(self.fn("가" * 80))


if __name__ == "__main__":
    unittest.main()
