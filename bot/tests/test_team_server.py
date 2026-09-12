"""team_server — proposals go to the desktop app first, then to the Worker."""
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

import modules.team_server as ts


def _resp(data: object) -> MagicMock:
    mock = MagicMock()
    mock.read.return_value = json.dumps(data).encode("utf-8")
    mock.__enter__ = lambda s: s
    mock.__exit__ = MagicMock(return_value=False)
    return mock


ENV = {"STRATA_SERVER_URL": "https://strata.example/", "STRATA_TEAM_TOKEN": "tok", "STRATA_BOT_AUTHOR": "슬랙봇"}
NO_ENV = {"STRATA_SERVER_URL": "", "STRATA_TEAM_TOKEN": ""}


class TestConfig(unittest.TestCase):
    def test_reads_env_and_normalises_url(self):
        with patch.dict("os.environ", ENV, clear=False):
            cfg = ts.team_server_config()
        self.assertEqual(cfg, {"url": "https://strata.example", "token": "tok", "author": "슬랙봇"})
        with patch.dict("os.environ", {"STRATA_SERVER_URL": "strata.example", "STRATA_TEAM_TOKEN": "t"}, clear=False):
            self.assertEqual(ts.team_server_config()["url"], "https://strata.example")

    def test_missing_pieces_mean_no_server(self):
        with patch.dict("os.environ", NO_ENV, clear=False):
            self.assertIsNone(ts.team_server_config())
        with patch.dict("os.environ", {"STRATA_SERVER_URL": "https://x", "STRATA_TEAM_TOKEN": ""}, clear=False):
            self.assertIsNone(ts.team_server_config())


class TestProposeViaServer(unittest.TestCase):
    def test_posts_with_token_and_encoded_author(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["headers"] = {k.lower(): v for k, v in req.header_items()}
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _resp({"ok": True, "path": "_agent/2026-09-12-idea.md", "title": "Idea"})

        with patch.dict("os.environ", ENV, clear=False), patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = ts.propose_via_server("Idea", "Body text", source="slack:kim", tags=["combat"])

        self.assertEqual(result["path"], "_agent/2026-09-12-idea.md")
        self.assertEqual(captured["url"], "https://strata.example/v1/propose")
        self.assertEqual(captured["headers"]["authorization"], "Bearer tok")
        self.assertEqual(captured["headers"]["x-author"], "%EC%8A%AC%EB%9E%99%EB%B4%87")
        self.assertEqual(captured["body"], {"title": "Idea", "body": "Body text", "source": "slack:kim", "tags": ["combat"]})

    def test_unconfigured_returns_none_without_network(self):
        with patch.dict("os.environ", NO_ENV, clear=False), patch("urllib.request.urlopen") as mock_open:
            self.assertIsNone(ts.propose_via_server("a", "b"))
            mock_open.assert_not_called()

    def test_unreachable_returns_none_and_http_error_raises(self):
        with patch.dict("os.environ", ENV, clear=False):
            with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")):
                self.assertIsNone(ts.propose_via_server("a", "b"))
            err = urllib.error.HTTPError("u", 401, "unauthorized", {}, io.BytesIO(b'{"error":"unauthorized"}'))
            with patch("urllib.request.urlopen", side_effect=err):
                with self.assertRaises(RuntimeError) as ctx:
                    ts.propose_via_server("a", "b")
                self.assertIn("401", str(ctx.exception))


class TestRecordProposal(unittest.TestCase):
    def test_prefers_the_desktop_app(self):
        with patch.object(ts, "propose_via_electron", return_value={"ok": True, "path": "local"}) as electron, \
             patch.object(ts, "propose_via_server") as server:
            self.assertEqual(ts.record_proposal("t", "b", source="s")["path"], "local")
            electron.assert_called_once_with("t", "b", source="s", tags=None)
            server.assert_not_called()

    def test_falls_back_to_the_server(self):
        with patch.object(ts, "propose_via_electron", return_value=None), \
             patch.object(ts, "propose_via_server", return_value={"ok": True, "path": "remote"}) as server:
            self.assertEqual(ts.record_proposal("t", "b", source="s", tags=["x"])["path"], "remote")
            server.assert_called_once_with("t", "b", source="s", tags=["x"])

    def test_unavailable_message_depends_on_configuration(self):
        with patch.dict("os.environ", ENV, clear=False):
            self.assertIn("Neither", ts.unavailable_message())
        with patch.dict("os.environ", NO_ENV, clear=False):
            self.assertIn("STRATA_SERVER_URL", ts.unavailable_message())


if __name__ == "__main__":
    unittest.main()
