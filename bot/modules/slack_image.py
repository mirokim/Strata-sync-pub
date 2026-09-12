"""Slack 이미지 처리 모듈

다운로드, 리사이즈, Claude Vision 묘사, 볼트 이미지 업로드 등
이미지 관련 작업을 SlackImageHandler 클래스로 캡슐화합니다.
"""
from __future__ import annotations

import os
import unicodedata
from typing import Callable

from PIL import Image as _PILImage
_PILImage.MAX_IMAGE_PIXELS = 50_000_000

from modules.constants import DEFAULT_SONNET_MODEL

# ── 상수 ────────────────────────────────────────────────────────────────────
_VISION_MODEL = DEFAULT_SONNET_MODEL  # 항상 Claude 사용 (GPT/Gemini 설정 무시)

# Slack CDN domains — only fetch images from these trusted hosts
_SLACK_CDN_DOMAINS = ("files.slack.com", "slack-files.com", "slack-edge.com", "files.slack-edge.com")

# Anthropic base64 이미지 한도: 5MB base64 ≈ 3.75MB raw → 여유분 포함 3.5MB
_MAX_IMG_BYTES = 3_500_000

_IMAGE_WORDS = ["이미지", "사진", "그림", "원화", "일러스트", "레퍼런스", "image", "photo", "pic"]
# 이미지 검색 시 제거할 동작/수량 단어 (주제어만 남기기 위함)
_ACTION_WORDS = ["보여줘", "보여주세요", "찾아줘", "찾아주세요", "보내줘", "보내주세요",
                 "줘", "주세요", "검색해줘", "있어", "있나요", "있어요",
                 "하나", "한장", "몇개", "주", "좀", "제발", "꼭"]


class SlackImageHandler:
    """Slack 이미지 다운로드, 리사이즈, Vision 묘사, 업로드를 담당하는 클래스."""

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
        Enterprise Grid 폴백: files.info API로 썸네일 URL을 받아 다운로드.
        url_private_download는 SSO에 막히지만 thumb_* URL은 별도 CDN에서 서빙되어
        봇 토큰 Authorization 헤더로 접근 가능한 경우가 많음.
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
                    self._log(f"[Vision] SSRF 차단: 허용되지 않은 URL {thumb_url[:80]}")
                    continue
                self._log(f"[Vision] Enterprise thumb 시도: {key}")
                r = _req.get(
                    thumb_url,
                    headers={"Authorization": f"Bearer {self._bot_token}"},
                    allow_redirects=True,
                    timeout=15,
                )
                if r.ok and r.content and r.content[:1] != b"<":
                    self._log(f"[Vision] thumb 다운로드 완료: {len(r.content)}바이트")
                    return r.content
        except Exception as e:
            self._log(f"[Vision] files.info 실패: {e}")
        return None

    def shrink_image(self, raw: bytes, mimetype: str, file_id: str | None) -> tuple[bytes, str] | None:
        """이미지를 Anthropic 허용 범위(≤3.5MB)로 줄임. PIL 리사이즈 → Slack thumb 순 폴백."""
        # PIL 리사이즈 시도
        try:
            from PIL import Image
            import io as _io
            # Decompression bomb protection: limit to 50MP
            if len(raw) > 20_000_000:
                self._log(f"[Vision] 이미지 크기 초과 ({len(raw)//1024//1024}MB), 건너뜀")
                raise ValueError("raw image too large")
            img = Image.open(_io.BytesIO(raw))
            # 장변 1568px 이하로 축소 (Anthropic 권장 최대치)
            if max(img.size) > 1568:
                ratio = 1568 / max(img.size)
                img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)
            # 투명도 채널 처리 후 JPEG 변환 (용량 절감)
            if img.mode == "RGBA":
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            elif img.mode in ("P", "LA"):
                img = img.convert("RGB")
            buf = _io.BytesIO()
            img.save(buf, format="JPEG", quality=85, optimize=True)
            result = buf.getvalue()
            self._log(f"[Vision] PIL 리사이즈 완료: {len(result)//1024}KB")
            return result, "image/jpeg"
        except ImportError:
            self._log("[Vision] PIL 없음 → Slack thumb 시도")
        except Exception as e:
            self._log(f"[Vision] PIL 오류: {e}")
        # Slack thumb 폴백 (files.info → thumb_1024/720/480)
        if file_id:
            thumb = self.fetch_via_files_info(file_id)
            if thumb:
                self._log(f"[Vision] Slack thumb 사용: {len(thumb)//1024}KB")
                return thumb, "image/jpeg"
        return None

    def download_images(self, image_files: list, download_fn: Callable) -> list[dict]:
        """이미지 다운로드 → [{"data": base64, "mediaType": str}] 리스트 반환.

        download_fn: slack_utils.download_slack_file 함수 (bot_token 바인딩 필요)
        """
        import base64 as _b64
        results = []
        for f in image_files[:3]:
            url = f.get("url_private_download") or f.get("url_private")
            raw = download_fn(url or "", self._bot_token, log_fn=self._log) if url else None
            file_id = f.get("id")
            # Enterprise Grid 폴백: SSO 차단 시 files.info → thumb URL 시도
            if not raw and file_id:
                raw = self.fetch_via_files_info(file_id)
            if not raw:
                self._log("[Vision] 다운로드 실패")
                continue
            mimetype = f.get("mimetype") or "image/png"
            # 너무 크면 리사이즈 (Anthropic 5MB base64 한도)
            if len(raw) > _MAX_IMG_BYTES:
                self._log(f"[Vision] {len(raw)//1024}KB 초과 → 리사이즈")
                shrunk = self.shrink_image(raw, mimetype, file_id)
                if not shrunk:
                    self._log("[Vision] 리사이즈 실패 → 스킵")
                    continue
                raw, mimetype = shrunk
            self._log(f"[Vision] {len(raw)//1024}KB magic={raw[:4].hex()}")
            results.append({"data": _b64.standard_b64encode(raw).decode(), "mediaType": mimetype})
        return results

    def describe_images(self, downloaded: list[dict], query: str) -> str | None:
        """다운로드된 이미지들을 Claude로 묘사 (RAG 쿼리 보강용). 실패 시 None."""
        if not self._api_key:
            return None
        content_parts: list = [
            {"type": "image", "source": {"type": "base64", "media_type": img["mediaType"], "data": img["data"]}}
            for img in downloaded
        ]
        desc_prompt = (
            f"{query}\n\n"
            "이미지에서 보이는 캐릭터의 외형(복장, 색상, 헤어, 표정, 분위기, 소품 등)을 "
            "구체적으로 묘사해주세요. 묘사만 출력, 평가나 결론은 제외."
        )
        content_parts.append({"type": "text", "text": desc_prompt})
        try:
            import anthropic as _ant
            msg = _ant.Anthropic(api_key=self._api_key).messages.create(
                model=_VISION_MODEL,
                max_tokens=800,
                system="당신은 게임 캐릭터 아트 분석 전문가입니다. 이미지를 객관적으로 묘사합니다.",
                messages=[{"role": "user", "content": content_parts}],
            )
            return msg.content[0].text
        except Exception as e:
            self._log(f"[Vision] 묘사 오류: {e}")
            return None

    def resolve_open_path(self, raw: str) -> str | None:
        """
        한글 파일명 Errno 22 방어: NFC → NFD → 원본 순으로 존재하는 경로 반환.
        abspath() 는 한국어 경로에서 OS 레벨 변환 오류를 일으킬 수 있어 사용하지 않음.
        """
        for norm in ("NFC", "NFD", None):
            p = unicodedata.normalize(norm, raw) if norm else raw
            if os.path.exists(p):
                return p
        return None  # 파일 없음

    def upload_images_to_slack(self, image_paths: list[str], channel: str, thread_ts: str | None) -> int:
        """볼트 이미지를 Slack에 업로드. 업로드 성공 건수 반환."""
        import requests as _req
        uploaded = 0
        for path in image_paths[:3]:
            try:
                open_path = self.resolve_open_path(path)
                if open_path is None:
                    self._log(f"[Image] 파일 없음 (경로 확인 필요): {os.path.basename(path)}")
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
                self._log(f"[Image] 업로드 완료: {filename}")
            except Exception as e:
                self._log(f"[Image] 업로드 실패 ({os.path.basename(path)}): {e}")
        return uploaded
