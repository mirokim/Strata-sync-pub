"""Slack image handling module

Encapsulates image-related work — download, resize, Claude Vision description,
vault image upload, etc. — in the SlackImageHandler class.
"""
from __future__ import annotations

import os
import unicodedata
from typing import Callable

from PIL import Image as _PILImage
_PILImage.MAX_IMAGE_PIXELS = 50_000_000

from modules.constants import DEFAULT_SONNET_MODEL

# ── Constants ────────────────────────────────────────────────────────────────
_VISION_MODEL = DEFAULT_SONNET_MODEL  # always use Claude (ignores GPT/Gemini settings)

# Slack CDN domains — only fetch images from these trusted hosts
_SLACK_CDN_DOMAINS = ("files.slack.com", "slack-files.com", "slack-edge.com", "files.slack-edge.com")

# Anthropic base64 image limit: 5MB base64 ≈ 3.75MB raw → 3.5MB with headroom
_MAX_IMG_BYTES = 3_500_000

_IMAGE_WORDS = ["이미지", "사진", "그림", "원화", "일러스트", "레퍼런스", "image", "photo", "pic"]
# Action/quantity words stripped from image searches (to keep only the topic words)
_ACTION_WORDS = ["보여줘", "보여주세요", "찾아줘", "찾아주세요", "보내줘", "보내주세요",
                 "줘", "주세요", "검색해줘", "있어", "있나요", "있어요",
                 "하나", "한장", "몇개", "주", "좀", "제발", "꼭"]


class SlackImageHandler:
    """Class responsible for Slack image download, resize, Vision description, and upload."""

    def __init__(self, web_client, bot_token: str, api_key: str, log_fn: Callable[[str], None]):
        self._web = web_client
        self._bot_token = bot_token
        self._api_key = api_key
        self._log = log_fn

    def is_safe_slack_url(self, url: str) -> bool:
        """Validate that a URL belongs to Slack's CDN (SSRF protection)."""
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url)
            if parsed.scheme != "https":
                return False
            host = parsed.hostname or ""
            return any(host == d or host.endswith("." + d) for d in _SLACK_CDN_DOMAINS)
        except Exception:
            return False

    def fetch_via_files_info(self, file_id: str) -> bytes | None:
        """
        Enterprise Grid fallback: fetch a thumbnail URL via the files.info API and download it.
        url_private_download is blocked by SSO, but thumb_* URLs are served from a separate CDN
        and are often accessible with the bot token Authorization header.
        """
        import requests as _req
        try:
            info = self._web.files_info(file=file_id)
            if not info.get("ok"):
                return None
            file_obj = info["file"]
            for key in ("thumb_1024", "thumb_720", "thumb_480", "thumb_360"):
                thumb_url = file_obj.get(key)
                if not thumb_url:
                    continue
                # SSRF guard: only fetch from Slack's own CDN domains
                if not self.is_safe_slack_url(thumb_url):
                    self._log(f"[Vision] SSRF blocked: disallowed URL {thumb_url[:80]}")
                    continue
                self._log(f"[Vision] Trying Enterprise thumb: {key}")
                r = _req.get(
                    thumb_url,
                    headers={"Authorization": f"Bearer {self._bot_token}"},
                    allow_redirects=True,
                    timeout=15,
                )
                if r.ok and r.content and r.content[:1] != b"<":
                    self._log(f"[Vision] thumb download complete: {len(r.content)} bytes")
                    return r.content
        except Exception as e:
            self._log(f"[Vision] files.info failed: {e}")
        return None

    def shrink_image(self, raw: bytes, mimetype: str, file_id: str | None) -> tuple[bytes, str] | None:
        """Shrink an image to the Anthropic limit (≤3.5MB). Fallback order: PIL resize → Slack thumb."""
        # Try PIL resize
        try:
            from PIL import Image
            import io as _io
            # Decompression bomb protection: limit to 50MP
            if len(raw) > 20_000_000:
                self._log(f"[Vision] Image too large ({len(raw)//1024//1024}MB), skipping")
                raise ValueError("raw image too large")
            img = Image.open(_io.BytesIO(raw))
            # Shrink the long edge to ≤1568px (Anthropic recommended maximum)
            if max(img.size) > 1568:
                ratio = 1568 / max(img.size)
                img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)
            # Handle the alpha channel, then convert to JPEG (reduces size)
            if img.mode == "RGBA":
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            elif img.mode in ("P", "LA"):
                img = img.convert("RGB")
            buf = _io.BytesIO()
            img.save(buf, format="JPEG", quality=85, optimize=True)
            result = buf.getvalue()
            self._log(f"[Vision] PIL resize complete: {len(result)//1024}KB")
            return result, "image/jpeg"
        except ImportError:
            self._log("[Vision] PIL not available → trying Slack thumb")
        except Exception as e:
            self._log(f"[Vision] PIL error: {e}")
        # Slack thumb fallback (files.info → thumb_1024/720/480)
        if file_id:
            thumb = self.fetch_via_files_info(file_id)
            if thumb:
                self._log(f"[Vision] Using Slack thumb: {len(thumb)//1024}KB")
                return thumb, "image/jpeg"
        return None

    def download_images(self, image_files: list, download_fn: Callable) -> list[dict]:
        """Download images → returns a list of [{"data": base64, "mediaType": str}].

        download_fn: the slack_utils.download_slack_file function (bot_token must be bound)
        """
        import base64 as _b64
        results = []
        for f in image_files[:3]:
            url = f.get("url_private_download") or f.get("url_private")
            raw = download_fn(url or "", self._bot_token, log_fn=self._log) if url else None
            file_id = f.get("id")
            # Enterprise Grid fallback: when blocked by SSO, try files.info → thumb URL
            if not raw and file_id:
                raw = self.fetch_via_files_info(file_id)
            if not raw:
                self._log("[Vision] Download failed")
                continue
            mimetype = f.get("mimetype") or "image/png"
            # Resize if too large (Anthropic 5MB base64 limit)
            if len(raw) > _MAX_IMG_BYTES:
                self._log(f"[Vision] {len(raw)//1024}KB exceeds limit → resizing")
                shrunk = self.shrink_image(raw, mimetype, file_id)
                if not shrunk:
                    self._log("[Vision] Resize failed → skipping")
                    continue
                raw, mimetype = shrunk
            self._log(f"[Vision] {len(raw)//1024}KB magic={raw[:4].hex()}")
            results.append({"data": _b64.standard_b64encode(raw).decode(), "mediaType": mimetype})
        return results

    def describe_images(self, downloaded: list[dict], query: str) -> str | None:
        """Describe downloaded images with Claude (to enrich the RAG query). None on failure."""
        if not self._api_key:
            return None
        content_parts: list = [
            {"type": "image", "source": {"type": "base64", "media_type": img["mediaType"], "data": img["data"]}}
            for img in downloaded
        ]
        desc_prompt = (
            f"{query}\n\n"
            "Describe in detail the appearance of the character shown in the image (outfit, colors, hair, "
            "expression, mood, props, etc.). Output only the description; no evaluation or conclusions."
        )
        content_parts.append({"type": "text", "text": desc_prompt})
        try:
            import anthropic as _ant
            msg = _ant.Anthropic(api_key=self._api_key).messages.create(
                model=_VISION_MODEL,
                max_tokens=800,
                system="You are a game character art analysis expert. Describe images objectively.",
                messages=[{"role": "user", "content": content_parts}],
            )
            return msg.content[0].text
        except Exception as e:
            self._log(f"[Vision] Description error: {e}")
            return None

    def resolve_open_path(self, raw: str) -> str | None:
        """
        Guard against Errno 22 on Korean filenames: return the first existing path in NFC → NFD → original order.
        abspath() is not used because it can trigger OS-level conversion errors on Korean paths.
        """
        for norm in ("NFC", "NFD", None):
            p = unicodedata.normalize(norm, raw) if norm else raw
            if os.path.exists(p):
                return p
        return None  # file not found

    def upload_images_to_slack(self, image_paths: list[str], channel: str, thread_ts: str | None) -> int:
        """Upload vault images to Slack. Returns the number of successful uploads."""
        import requests as _req
        uploaded = 0
        for path in image_paths[:3]:
            try:
                open_path = self.resolve_open_path(path)
                if open_path is None:
                    self._log(f"[Image] File not found (check path): {os.path.basename(path)}")
                    continue
                with open(open_path, "rb") as f:
                    content = f.read()
                filename = os.path.basename(open_path)
                resp = self._web.files_getUploadURLExternal(filename=filename, length=len(content))
                upload_url = resp["upload_url"]
                file_id = resp["file_id"]
                _req.post(upload_url, data=content, timeout=30, verify=True)
                kw: dict = {"files": [{"id": file_id, "title": filename}], "channel_id": channel}
                if thread_ts:
                    kw["thread_ts"] = thread_ts
                self._web.files_completeUploadExternal(**kw)
                uploaded += 1
                self._log(f"[Image] Upload complete: {filename}")
            except Exception as e:
                self._log(f"[Image] Upload failed ({os.path.basename(path)}): {e}")
        return uploaded
