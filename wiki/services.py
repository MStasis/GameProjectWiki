from __future__ import annotations

import hashlib
import html
import re
import uuid
from collections import defaultdict
from datetime import datetime
from io import BytesIO
from urllib.parse import parse_qs, quote, urlencode, urlparse

import bleach
from bleach.css_sanitizer import CSSSanitizer
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone
from django.utils.html import escape, format_html, strip_tags
from django.utils.safestring import mark_safe
from PIL import Image, UnidentifiedImageError

from .models import Asset, PageContent, PageRevision, WikiNode


MAX_BLOCKS = 500
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_IMAGE_FORMATS = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}
ALLOWED_TAGS = {
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "mark",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "a",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "span",
    "sub",
    "sup",
}
ALLOWED_ATTRIBUTES = {
    "a": ["href", "title", "target", "rel"],
    "span": ["style"],
    "p": ["style"],
    "h1": ["style"],
    "h2": ["style"],
    "h3": ["style"],
    "h4": ["style"],
    "h5": ["style"],
    "h6": ["style"],
    "th": ["colspan", "rowspan", "style"],
    "td": ["colspan", "rowspan", "style"],
    "mark": ["style"],
}
CSS_SANITIZER = CSSSanitizer(
    allowed_css_properties=[
        "color",
        "background-color",
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "text-align",
        "text-decoration",
        "line-height",
    ]
)
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
SHEET_ID_RE = re.compile(r"^[A-Za-z0-9_-]{20,}$")
A1_RANGE_RE = re.compile(
    r"^(?:'[^']+'|[A-Za-z0-9_가-힣 -]+)!"
    r"(?:[A-Za-z]{1,4}\d+(?::[A-Za-z]{1,4}\d*)?|[A-Za-z]{1,4}:[A-Za-z]{1,4}|\d+:\d+)$"
    r"|^(?:[A-Za-z]{1,4}\d+(?::[A-Za-z]{1,4}\d*)?|[A-Za-z]{1,4}:[A-Za-z]{1,4}|\d+:\d+)$"
)


def sanitize_html(raw_html: str) -> str:
    """Return rich text HTML limited to the editor's safe formatting subset."""
    cleaned = bleach.clean(
        raw_html or "",
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols={"http", "https", "mailto"},
        css_sanitizer=CSS_SANITIZER,
        strip=True,
        strip_comments=True,
    )
    # Links opened in a new tab must not receive an opener reference.
    cleaned = re.sub(
        r'<a\s+([^>]*?)target=["\']_blank["\']([^>]*)>',
        lambda match: _safe_external_anchor(match.group(1), match.group(2)),
        cleaned,
        flags=re.IGNORECASE,
    )
    return cleaned


def _safe_external_anchor(before: str, after: str) -> str:
    attributes = f"{before}{after}"
    attributes = re.sub(r"\srel=[\"'][^\"']*[\"']", "", attributes, flags=re.I)
    return f'<a {attributes.strip()} target="_blank" rel="noopener noreferrer">'


def _parse_seconds(value: str | int | None) -> int:
    if value is None:
        return 0
    if isinstance(value, int):
        return max(0, value)
    value = str(value).strip().lower()
    if value.isdigit():
        return int(value)
    match = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", value)
    if not match:
        return 0
    hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds


def canonicalize_youtube_url(url: str, *, video_id: str = "", start: int | str | None = None) -> dict:
    raw = (url or "").strip()
    if raw and "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlparse(raw) if raw else None
    candidate = (video_id or "").strip()
    query: dict[str, list[str]] = {}
    fragment_query: dict[str, list[str]] = {}

    if parsed:
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        allowed = {"youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"}
        if host not in allowed:
            raise ValidationError("YouTube 링크만 사용할 수 있습니다.")
        query = parse_qs(parsed.query)
        fragment_query = parse_qs(parsed.fragment)
        path_parts = [part for part in parsed.path.split("/") if part]
        if host == "youtu.be" and path_parts:
            candidate = path_parts[0]
        elif query.get("v"):
            candidate = query["v"][0]
        elif path_parts and path_parts[0] in {"embed", "shorts", "live"} and len(path_parts) > 1:
            candidate = path_parts[1]

    if not YOUTUBE_ID_RE.fullmatch(candidate):
        raise ValidationError("올바른 YouTube 영상 링크가 아닙니다.")

    start_value = start
    if start_value is None:
        start_value = (query.get("t") or query.get("start") or fragment_query.get("t") or [None])[0]
    start_seconds = _parse_seconds(start_value)
    canonical_url = f"https://www.youtube.com/watch?v={candidate}"
    embed_url = f"https://www.youtube-nocookie.com/embed/{candidate}"
    if start_seconds:
        canonical_url += f"&t={start_seconds}s"
        embed_url += f"?start={start_seconds}"
    return {
        "url": canonical_url,
        "videoId": candidate,
        "embedUrl": embed_url,
        "start": start_seconds,
    }


def canonicalize_google_sheet(
    url: str,
    *,
    spreadsheet_id: str = "",
    gid: str | int | None = None,
    cell_range: str = "",
) -> dict:
    raw = (url or "").strip()
    if raw and "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlparse(raw) if raw else None
    candidate = (spreadsheet_id or "").strip()
    query: dict[str, list[str]] = {}
    fragment: dict[str, list[str]] = {}
    published = False

    if parsed:
        host = (parsed.hostname or "").lower()
        if host != "docs.google.com":
            raise ValidationError("Google Sheets 링크만 사용할 수 있습니다.")
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 3 and parts[0] == "spreadsheets" and parts[1] == "d":
            if parts[2] == "e" and len(parts) >= 4:
                candidate = parts[3]
                published = True
            else:
                candidate = parts[2]
        query = parse_qs(parsed.query)
        fragment = parse_qs(parsed.fragment)

    if not SHEET_ID_RE.fullmatch(candidate):
        raise ValidationError("올바른 Google Sheets 링크가 아닙니다.")

    selected_gid = str(gid if gid not in (None, "") else (query.get("gid") or fragment.get("gid") or ["0"])[0])
    if not selected_gid.isdigit():
        raise ValidationError("시트 gid는 숫자여야 합니다.")
    selected_range = (cell_range or (query.get("range") or fragment.get("range") or [""])[0]).strip()
    if selected_range and not A1_RANGE_RE.fullmatch(selected_range):
        raise ValidationError("범위는 A1:C20 같은 A1 표기법으로 입력해 주세요.")

    if published:
        params = {"gid": selected_gid, "single": "true", "widget": "true", "headers": "false"}
        if selected_range:
            params["range"] = selected_range
        embed_url = f"https://docs.google.com/spreadsheets/d/e/{candidate}/pubhtml?{urlencode(params)}"
        source_url = f"https://docs.google.com/spreadsheets/d/e/{candidate}/pubhtml?gid={selected_gid}&single=true"
    else:
        params = {"tqx": "out:html", "gid": selected_gid}
        if selected_range:
            params["range"] = selected_range
        embed_url = f"https://docs.google.com/spreadsheets/d/{candidate}/gviz/tq?{urlencode(params)}"
        source_url = f"https://docs.google.com/spreadsheets/d/{candidate}/edit#gid={selected_gid}"
    return {
        "url": source_url,
        "spreadsheetId": candidate,
        "gid": selected_gid,
        "range": selected_range,
        "embedUrl": embed_url,
        "published": published,
    }


def _clean_plain_text(value, *, limit: int = 1000) -> str:
    return bleach.clean(str(value or ""), tags=set(), strip=True)[:limit]


def _sanitize_json_value(value, depth: int = 0):
    if depth > 4:
        raise ValidationError("속성의 중첩 단계가 너무 깊습니다.")
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _clean_plain_text(value, limit=5000)
    if isinstance(value, list):
        return [_sanitize_json_value(item, depth + 1) for item in value[:100]]
    if isinstance(value, dict):
        return {
            _clean_plain_text(key, limit=80): _sanitize_json_value(item, depth + 1)
            for key, item in list(value.items())[:100]
        }
    return _clean_plain_text(value, limit=5000)


def normalize_properties(properties) -> dict:
    if properties in (None, ""):
        return {}
    if not isinstance(properties, dict):
        raise ValidationError("페이지 속성은 객체 형식이어야 합니다.")
    return _sanitize_json_value(properties)


def normalize_template(template: str) -> str:
    candidate = str(template or "default").strip().lower()
    if not re.fullmatch(r"[a-z0-9_-]{1,50}", candidate):
        raise ValidationError("올바르지 않은 페이지 템플릿입니다.")
    return candidate


def normalize_blocks(blocks) -> list[dict]:
    if not isinstance(blocks, list):
        raise ValidationError("콘텐츠 블록은 배열 형식이어야 합니다.")
    if len(blocks) > MAX_BLOCKS:
        raise ValidationError(f"한 페이지에는 최대 {MAX_BLOCKS}개의 블록을 저장할 수 있습니다.")

    normalized: list[dict] = []
    for raw_block in blocks:
        if not isinstance(raw_block, dict):
            raise ValidationError("올바르지 않은 콘텐츠 블록이 포함되어 있습니다.")
        block_type = str(raw_block.get("type") or "").strip().lower().replace("-", "_")
        block_type = {
            "text": "rich_text",
            "richtext": "rich_text",
            "sheet": "google_sheet",
            "googlesheet": "google_sheet",
            "video": "youtube",
        }.get(block_type, block_type)
        data = raw_block.get("data", {})
        if isinstance(data, str):
            data = {"html": data}
        if not isinstance(data, dict):
            raise ValidationError("블록 데이터는 객체 형식이어야 합니다.")
        block_id = str(raw_block.get("id") or uuid.uuid4())[:80]

        if block_type == "rich_text":
            raw_html = data.get("html", raw_block.get("html", ""))
            normalized_data = {"html": sanitize_html(str(raw_html or ""))}
        elif block_type == "image":
            asset_id = (
                data.get("assetId")
                or data.get("asset_id")
                or raw_block.get("assetId")
                or raw_block.get("asset_id")
            )
            try:
                asset = Asset.objects.get(pk=asset_id, is_deleted=False)
            except (Asset.DoesNotExist, ValueError, TypeError):
                raise ValidationError("업로드된 이미지를 찾을 수 없습니다.")
            normalized_data = {
                "assetId": str(asset.pk),
                "url": asset.file.url,
                "alt": _clean_plain_text(data.get("alt", raw_block.get("alt", asset.alt_text)), limit=240),
                "caption": _clean_plain_text(
                    data.get("caption", raw_block.get("caption", asset.caption)), limit=500
                ),
            }
        elif block_type == "youtube":
            normalized_data = canonicalize_youtube_url(
                data.get("url", raw_block.get("url", "")),
                video_id=(
                    data.get("videoId")
                    or data.get("video_id")
                    or raw_block.get("videoId")
                    or raw_block.get("video_id")
                    or ""
                ),
                start=data.get("start", raw_block.get("start")),
            )
            normalized_data["caption"] = _clean_plain_text(
                data.get("caption", raw_block.get("caption", "")), limit=500
            )
        elif block_type == "google_sheet":
            normalized_data = canonicalize_google_sheet(
                data.get("url", raw_block.get("url", "")),
                spreadsheet_id=(
                    data.get("spreadsheetId")
                    or data.get("spreadsheet_id")
                    or raw_block.get("spreadsheetId")
                    or raw_block.get("spreadsheet_id")
                    or ""
                ),
                gid=data.get("gid", raw_block.get("gid")),
                cell_range=data.get("range", raw_block.get("range", "")),
            )
            normalized_data["title"] = _clean_plain_text(
                data.get("title", raw_block.get("title", "")), limit=180
            )
            height = data.get("height", raw_block.get("height", 480))
            try:
                height = min(1200, max(240, int(height)))
            except (TypeError, ValueError):
                height = 480
            normalized_data["height"] = height
        elif block_type == "callout":
            tone = str(data.get("tone", raw_block.get("tone", "note"))).lower()
            if tone not in {"info", "note", "success", "warning", "danger"}:
                tone = "note"
            normalized_data = {
                "tone": tone,
                "title": _clean_plain_text(data.get("title", raw_block.get("title", "")), limit=180),
                "html": sanitize_html(str(data.get("html", raw_block.get("html", "")) or "")),
            }
        elif block_type == "divider":
            normalized_data = {}
        else:
            raise ValidationError(f"지원하지 않는 블록 형식입니다: {block_type or '(없음)'}")
        normalized.append({"id": block_id, "type": block_type, "data": normalized_data})
    return normalized


def build_search_text(node: WikiNode, blocks: list[dict], properties: dict) -> str:
    return build_search_text_values(
        title=node.title,
        summary=node.summary,
        tags=list(node.tags.values_list("name", flat=True)),
        blocks=blocks,
        properties=properties,
    )


def build_search_text_values(*, title: str, summary: str, tags, blocks: list[dict], properties: dict) -> str:
    values = [title, summary]
    for block in blocks:
        data = block.get("data", {})
        if block.get("type") == "rich_text":
            values.append(html.unescape(strip_tags(data.get("html", ""))))
        else:
            for key in ("alt", "caption", "title", "range"):
                if data.get(key):
                    values.append(str(data[key]))
    for key, value in properties.items():
        values.extend((str(key), _flatten_property_text(value)))
    values.extend(str(tag) for tag in tags)
    return " ".join(" ".join(values).split())[:100_000]


def _flatten_property_text(value) -> str:
    if isinstance(value, dict):
        return " ".join(f"{key} {_flatten_property_text(item)}" for key, item in value.items())
    if isinstance(value, list):
        return " ".join(_flatten_property_text(item) for item in value)
    return str(value or "")


def rendered_blocks(blocks: list[dict]) -> list[dict]:
    """Build template-friendly blocks; rich text is safe because it was sanitized above."""
    asset_ids = [
        block.get("data", {}).get("assetId")
        for block in blocks
        if block.get("type") == "image"
    ]
    assets = {
        str(asset.pk): asset
        for asset in Asset.objects.filter(pk__in=[item for item in asset_ids if item], is_deleted=False)
    }
    result = []
    for block in blocks:
        block_type = block.get("type")
        data = dict(block.get("data", {}))
        rendered = {"id": block.get("id"), "type": block_type, "kind": block_type, "data": data}
        if block_type == "rich_text":
            rendered["html"] = mark_safe(sanitize_html(data.get("html", "")))
        elif block_type == "image":
            asset = assets.get(str(data.get("assetId")))
            if asset:
                data["url"] = asset.file.url
                rendered["asset"] = asset
                caption = data.get("caption", "")
                caption_html = format_html("<figcaption>{}</figcaption>", caption) if caption else ""
                rendered["html"] = format_html(
                    '<figure><img src="{}" alt="{}" loading="lazy" decoding="async">{}</figure>',
                    asset.file.url,
                    data.get("alt", ""),
                    mark_safe(caption_html),
                )
            else:
                rendered["missing"] = True
                rendered["html"] = mark_safe('<p class="embed-error">이미지를 찾을 수 없습니다.</p>')
        elif block_type == "youtube":
            try:
                data.update(
                    canonicalize_youtube_url(
                        data.get("url", ""),
                        video_id=data.get("videoId", ""),
                        start=data.get("start"),
                    )
                )
            except ValidationError:
                rendered["missing"] = True
                rendered["html"] = mark_safe('<p class="embed-error">YouTube 링크가 올바르지 않습니다.</p>')
                result.append(rendered)
                continue
            caption = data.get("caption", "")
            caption_html = format_html("<figcaption>{}</figcaption>", caption) if caption else ""
            rendered["html"] = format_html(
                '<figure class="video-embed"><div class="embed-ratio"><iframe src="{}" '
                'title="YouTube video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; '
                'encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>{}</figure>',
                data.get("embedUrl", ""),
                mark_safe(caption_html),
            )
        elif block_type == "google_sheet":
            try:
                data.update(
                    canonicalize_google_sheet(
                        data.get("url", ""),
                        spreadsheet_id=data.get("spreadsheetId", ""),
                        gid=data.get("gid"),
                        cell_range=data.get("range", ""),
                    )
                )
            except ValidationError:
                rendered["missing"] = True
                rendered["html"] = mark_safe(
                    '<p class="embed-error">Google Sheets 링크가 올바르지 않습니다.</p>'
                )
                result.append(rendered)
                continue
            rendered["html"] = format_html(
                '<figure class="sheet-embed"><iframe src="{}" title="{}" height="{}" '
                'loading="lazy"></iframe><a href="{}" target="_blank" rel="noopener noreferrer">'
                'Google Sheets에서 열기</a></figure>',
                data.get("embedUrl", ""),
                data.get("title") or "Google Sheets",
                data.get("height", 480),
                data.get("url", ""),
            )
        elif block_type == "divider":
            rendered["html"] = mark_safe("<hr>")
        elif block_type == "callout":
            title = data.get("title", "")
            tone = data.get("tone", "note")
            if tone not in {"info", "note", "success", "warning", "danger"}:
                tone = "note"
            title_html = format_html("<strong>{}</strong>", title) if title else ""
            rendered["html"] = format_html(
                '<aside class="callout callout--{}">{}{}</aside>',
                tone,
                mark_safe(title_html),
                mark_safe(sanitize_html(data.get("html", ""))),
            )
        result.append(rendered)
    return result


def build_tree(nodes) -> list[dict]:
    node_list = list(nodes)
    by_parent: dict[uuid.UUID | None, list[WikiNode]] = defaultdict(list)
    for node in node_list:
        by_parent[node.parent_id].append(node)
    for children in by_parent.values():
        children.sort(key=lambda item: (item.position, item.title.casefold(), str(item.pk)))

    def visit(node: WikiNode, depth: int, visited: set[uuid.UUID]) -> dict:
        if node.pk in visited:
            return {"node": node, "children": [], "depth": depth, "cycle": True}
        next_visited = {*visited, node.pk}
        return {
            "node": node,
            "depth": depth,
            "children": [visit(child, depth + 1, next_visited) for child in by_parent.get(node.pk, [])],
        }

    return [visit(root, 0, set()) for root in by_parent.get(None, [])]


def descendant_ids(node: WikiNode, *, include_self: bool = False) -> list[uuid.UUID]:
    found = [node.pk] if include_self else []
    frontier = [node.pk]
    seen = {node.pk}
    while frontier:
        children = list(
            WikiNode.objects.filter(parent_id__in=frontier).values_list("pk", flat=True)
        )
        frontier = [child for child in children if child not in seen]
        seen.update(frontier)
        found.extend(frontier)
    return found


def next_position(parent: WikiNode | None) -> int:
    maximum = (
        WikiNode.objects.filter(parent=parent, is_deleted=False).aggregate(value=Max("position"))["value"]
        or 0
    )
    return maximum + 10


@transaction.atomic
def move_node(
    node: WikiNode,
    *,
    new_parent: WikiNode | None,
    before_id=None,
    after_id=None,
    position=None,
    actor=None,
) -> WikiNode:
    node = WikiNode.objects.select_for_update().get(pk=node.pk)
    if node.is_deleted:
        raise ValidationError("휴지통의 항목은 이동할 수 없습니다.")
    if new_parent is not None:
        new_parent = WikiNode.objects.select_for_update().get(pk=new_parent.pk)
        if new_parent.is_deleted or new_parent.kind != WikiNode.Kind.FOLDER:
            raise ValidationError("활성 폴더 아래로만 이동할 수 있습니다.")
        if new_parent.pk == node.pk or new_parent.pk in descendant_ids(node):
            raise ValidationError("자신 또는 자신의 하위 항목으로 이동할 수 없습니다.")

    siblings = list(
        WikiNode.objects.select_for_update()
        .filter(parent=new_parent, is_deleted=False)
        .exclude(pk=node.pk)
        .order_by("position", "title", "pk")
    )
    sibling_ids = [str(item.pk) for item in siblings]
    if before_id:
        try:
            insert_at = sibling_ids.index(str(before_id))
        except ValueError as exc:
            raise ValidationError("기준 항목을 같은 폴더에서 찾을 수 없습니다.") from exc
    elif after_id:
        try:
            insert_at = sibling_ids.index(str(after_id)) + 1
        except ValueError as exc:
            raise ValidationError("기준 항목을 같은 폴더에서 찾을 수 없습니다.") from exc
    elif position is not None:
        try:
            insert_at = min(len(siblings), max(0, int(position)))
        except (TypeError, ValueError) as exc:
            raise ValidationError("올바르지 않은 이동 위치입니다.") from exc
    else:
        insert_at = len(siblings)

    siblings.insert(insert_at, node)
    now = timezone.now()
    for index, sibling in enumerate(siblings):
        sibling.parent = new_parent
        sibling.position = index * 10
        sibling.updated_at = now
        if sibling.pk == node.pk:
            sibling.updated_by = actor
    WikiNode.objects.bulk_update(siblings, ("parent", "position", "updated_at", "updated_by"))
    node.refresh_from_db()
    return node


@transaction.atomic
def soft_delete_subtree(node: WikiNode, actor=None) -> uuid.UUID:
    node = WikiNode.objects.select_for_update().get(pk=node.pk)
    if node.is_deleted and node.deletion_batch:
        return node.deletion_batch
    batch = uuid.uuid4()
    ids = descendant_ids(node, include_self=True)
    now = timezone.now()
    WikiNode.objects.select_for_update().filter(pk__in=ids, is_deleted=False).update(
        is_deleted=True,
        deleted_at=now,
        deletion_batch=batch,
        deleted_by=actor,
        updated_by=actor,
        updated_at=now,
    )
    return batch


@transaction.atomic
def restore_deleted_node(node: WikiNode, actor=None) -> int:
    node = WikiNode.objects.select_for_update().get(pk=node.pk)
    if not node.is_deleted:
        return 0
    queryset = WikiNode.objects.filter(deletion_batch=node.deletion_batch) if node.deletion_batch else WikiNode.objects.filter(pk=node.pk)
    now = timezone.now()
    return queryset.select_for_update().update(
        is_deleted=False,
        deleted_at=None,
        deletion_batch=None,
        deleted_by=None,
        updated_by=actor,
        updated_at=now,
    )


@transaction.atomic
def create_revision(page: PageContent, actor=None, reason: str = "") -> PageRevision:
    page = PageContent.objects.select_for_update().select_related("node").get(pk=page.pk)
    last_number = page.revisions.aggregate(value=Max("number"))["value"] or 0
    draft_meta = page.draft_meta if isinstance(page.draft_meta, dict) else {}
    return PageRevision.objects.create(
        page=page,
        number=last_number + 1,
        title=draft_meta.get("title", page.node.title),
        summary=draft_meta.get("summary", page.node.summary),
        parent_node_id=draft_meta.get("parentId", page.node.parent_id),
        blocks=page.blocks,
        properties=page.properties,
        template=page.template,
        status=page.node.status,
        tags=draft_meta.get("tags", list(page.node.tags.values_list("name", flat=True))),
        reason=(reason or "")[:120],
        created_by=actor,
    )


def validate_image_upload(uploaded_file) -> tuple[str, int, int, str]:
    prepared, mime_type, width, height, digest = prepare_image_upload(uploaded_file)
    return mime_type, width, height, digest


def prepare_image_upload(uploaded_file) -> tuple[ContentFile, str, int, int, str]:
    """Decode and re-encode an image so metadata and trailing payloads are discarded."""
    if uploaded_file.size > MAX_UPLOAD_BYTES:
        raise ValidationError(f"이미지는 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 이하만 업로드할 수 있습니다.")
    try:
        payload = uploaded_file.read()
        if len(payload) > MAX_UPLOAD_BYTES:
            raise ValidationError("이미지 파일이 너무 큽니다.")
        with Image.open(BytesIO(payload)) as image:
            image_format = (image.format or "").upper()
            width, height = image.size
            if image_format not in ALLOWED_IMAGE_FORMATS:
                raise ValidationError("JPG, PNG, WebP 이미지만 업로드할 수 있습니다.")
            if width * height > 40_000_000 or width > 12_000 or height > 12_000:
                raise ValidationError("이미지 해상도가 너무 큽니다.")
            image.load()
            output = BytesIO()
            if image_format == "JPEG":
                decoded = image.convert("RGB")
                decoded.save(output, format="JPEG", quality=90, optimize=True, progressive=True)
                extension = ".jpg"
            elif image_format == "PNG":
                has_alpha = image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info)
                decoded = image.convert("RGBA" if has_alpha else "RGB")
                decoded.save(output, format="PNG", optimize=True)
                extension = ".png"
            else:
                has_alpha = image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info)
                decoded = image.convert("RGBA" if has_alpha else "RGB")
                decoded.save(output, format="WEBP", quality=90, method=6)
                extension = ".webp"
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ValidationError("손상되었거나 지원하지 않는 이미지입니다.") from exc
    finally:
        uploaded_file.seek(0)
    encoded = output.getvalue()
    if len(encoded) > MAX_UPLOAD_BYTES:
        raise ValidationError("변환된 이미지 파일이 너무 큽니다.")
    digest = hashlib.sha256(encoded).hexdigest()
    prepared = ContentFile(encoded, name=f"{uuid.uuid4()}{extension}")
    return prepared, ALLOWED_IMAGE_FORMATS[image_format], width, height, digest


def json_error_message(error: Exception) -> str:
    if isinstance(error, ValidationError):
        if hasattr(error, "message_dict"):
            return " ".join(message for messages in error.message_dict.values() for message in messages)
        return " ".join(error.messages)
    return str(error)
