from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path

from django.contrib import messages
from django.contrib.auth.decorators import user_passes_test
from django.contrib.auth.views import LoginView
from django.core.cache import cache
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Prefetch, Q
from django.http import Http404, HttpResponseBadRequest, JsonResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .forms import AssetUploadForm, PageEditorForm, SearchForm, StaffAuthenticationForm, WikiNodeForm
from .models import Asset, PageContent, PageRevision, Tag, WikiNode
from .services import (
    MAX_UPLOAD_BYTES,
    build_search_text,
    build_search_text_values,
    build_tree,
    create_revision,
    json_error_message,
    move_node,
    next_position,
    normalize_blocks,
    normalize_properties,
    normalize_template,
    rendered_blocks,
    restore_deleted_node,
    soft_delete_subtree,
    prepare_image_upload,
)


staff_required = user_passes_test(
    lambda user: user.is_authenticated and user.is_active and user.is_staff,
    login_url="wiki:login",
)


class StaffLoginView(LoginView):
    template_name = "wiki/login.html"
    authentication_form = StaffAuthenticationForm
    throttle_limit = 6
    throttle_seconds = 15 * 60

    def _throttle_key(self):
        identity = "|".join(
            [
                self.request.META.get("REMOTE_ADDR", "unknown"),
                self.request.POST.get("username", "").strip().casefold(),
            ]
        )
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        return f"wiki-login:{digest}"

    def dispatch(self, request, *args, **kwargs):
        if request.user.is_authenticated:
            if request.user.is_staff:
                return redirect(self.get_success_url())
            raise PermissionDenied
        return super().dispatch(request, *args, **kwargs)

    def post(self, request, *args, **kwargs):
        if cache.get(self._throttle_key(), 0) >= self.throttle_limit:
            form = self.get_form()
            form.add_error(None, "로그인 시도가 너무 많습니다. 15분 뒤 다시 시도해 주세요.")
            return self.render_to_response(self.get_context_data(form=form), status=429)
        return super().post(request, *args, **kwargs)

    def form_invalid(self, form):
        key = self._throttle_key()
        cache.set(key, cache.get(key, 0) + 1, self.throttle_seconds)
        return super().form_invalid(form)

    def form_valid(self, form):
        cache.delete(self._throttle_key())
        return super().form_valid(form)


def _wants_json(request) -> bool:
    return (
        request.content_type == "application/json"
        or "application/json" in request.headers.get("Accept", "")
        or request.GET.get("format") == "json"
    )


def _json_payload(request) -> dict:
    try:
        payload = json.loads(request.body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValidationError("올바른 JSON 요청이 아닙니다.") from exc
    if not isinstance(payload, dict):
        raise ValidationError("JSON 요청 본문은 객체여야 합니다.")
    return payload


def _error_response(request, error: Exception, *, status: int = 400):
    message = json_error_message(error)
    if _wants_json(request):
        return JsonResponse(
            {"ok": False, "error": message, "code": "validation_error", "message": message},
            status=status,
        )
    return HttpResponseBadRequest(message)


def _action_response(request, node: WikiNode, message_text: str, **extra):
    if _wants_json(request):
        return JsonResponse(
            {
                "ok": True,
                "nodeId": str(node.pk),
                "status": node.status,
                "url": node.get_absolute_url(),
                "message": message_text,
                **extra,
            }
        )
    messages.success(request, message_text)
    return redirect(node.get_absolute_url())


def _visible_to_public(node: WikiNode) -> bool:
    return node.is_publicly_visible()


def _node_for_view(request, node_id, *, include_deleted_for_staff: bool = False) -> WikiNode:
    queryset = WikiNode.objects.select_related("parent").prefetch_related("tags")
    if not (request.user.is_authenticated and request.user.is_staff and include_deleted_for_staff):
        queryset = queryset.alive()
    node = get_object_or_404(queryset, pk=node_id)
    if not (request.user.is_authenticated and request.user.is_staff) and not _visible_to_public(node):
        raise Http404
    return node


def _public_candidates(queryset, *, limit: int | None = None) -> list[WikiNode]:
    result = []
    for node in queryset:
        if node.is_publicly_visible():
            result.append(node)
            if limit and len(result) >= limit:
                break
    return result


def _folder_prefetch(*, public_only: bool = False):
    children = WikiNode.objects.alive().order_by("position", "title")
    if public_only:
        children = children.filter(status=WikiNode.Status.PUBLISHED)
    grandchildren = WikiNode.objects.alive().order_by("position", "title")
    if public_only:
        grandchildren = grandchildren.filter(status=WikiNode.Status.PUBLISHED)
    return Prefetch("children", queryset=children.prefetch_related(Prefetch("children", queryset=grandchildren)))


def _parent_options(exclude: WikiNode | None = None) -> list[WikiNode]:
    folders = list(WikiNode.objects.alive().filter(kind=WikiNode.Kind.FOLDER).select_related("parent"))
    excluded = set()
    if exclude:
        from .services import descendant_ids

        excluded = set(descendant_ids(exclude, include_self=True))
    result = []
    for folder in folders:
        if folder.pk in excluded:
            continue
        depth = len(folder.get_ancestors())
        folder.depth_prefix = "— " * depth
        result.append(folder)
    return sorted(result, key=lambda item: ([part.position for part in item.get_ancestors(include_self=True)], item.title))


def _tag_names(raw) -> list[str]:
    if raw is None:
        return []
    values = raw if isinstance(raw, list) else str(raw).replace("\n", ",").split(",")
    result = []
    seen = set()
    for value in values:
        name = " ".join(str(value).strip().lstrip("#").split())[:50]
        key = name.casefold()
        if name and key not in seen:
            result.append(name)
            seen.add(key)
    return result[:50]


def _set_node_tags(node: WikiNode, raw) -> list[Tag]:
    tags = []
    for name in _tag_names(raw):
        tag = Tag.objects.filter(name__iexact=name).first()
        if tag is None:
            try:
                tag = Tag.objects.create(name=name)
            except IntegrityError:
                tag = Tag.objects.get(name__iexact=name)
        tags.append(tag)
    node.tags.set(tags)
    return tags


def _editor_post_content(request, current: PageContent | None = None) -> tuple[list, dict, str]:
    blocks_raw = request.POST.get("blocks_json")
    if blocks_raw is None:
        blocks_raw = request.POST.get("blocks")
    if blocks_raw in (None, ""):
        blocks = current.blocks if current else []
    else:
        try:
            blocks = json.loads(blocks_raw)
        except json.JSONDecodeError as exc:
            raise ValidationError("콘텐츠 블록 JSON을 읽을 수 없습니다.") from exc

    properties_raw = request.POST.get("properties_json")
    if properties_raw:
        try:
            properties = json.loads(properties_raw)
        except json.JSONDecodeError as exc:
            raise ValidationError("속성 JSON을 읽을 수 없습니다.") from exc
    else:
        keys = request.POST.getlist("property_key")
        values = request.POST.getlist("property_value")
        if keys:
            properties = {key: values[index] if index < len(values) else "" for index, key in enumerate(keys) if key.strip()}
        else:
            properties = current.properties if current else {}
    template = request.POST.get("template", current.template if current else "default")
    return normalize_blocks(blocks), normalize_properties(properties), normalize_template(template)


def _properties_for_template(properties: dict) -> list[dict]:
    return [
        {"key": key, "value": value if isinstance(value, (str, int, float)) else json.dumps(value, ensure_ascii=False)}
        for key, value in properties.items()
    ]


def _editor_context(request, *, node: WikiNode | None, content: PageContent | None, form: PageEditorForm):
    initial_blocks = content.blocks if content else []
    properties = content.properties if content else {}
    draft_meta = content.draft_meta if content and node and node.status == WikiNode.Status.PUBLISHED else {}
    if node and draft_meta:
        node.title = draft_meta.get("title", node.title)
        node.summary = draft_meta.get("summary", node.summary)
        parent_id = draft_meta.get("parentId", node.parent_id)
        try:
            node.parent_id = uuid.UUID(parent_id) if parent_id else None
        except (ValueError, TypeError, AttributeError):
            pass
    save_url = reverse("wiki:autosave", kwargs={"node_id": node.pk}) if node else reverse("wiki:editor")
    move_url = reverse("wiki:node_move", kwargs={"node_id": node.pk}) if node else ""
    publish_url = reverse("wiki:publish", kwargs={"node_id": node.pk}) if node else reverse("wiki:editor")
    unpublish_url = reverse("wiki:unpublish", kwargs={"node_id": node.pk}) if node else ""
    if node and content:
        node.template = content.template
    return {
        "node": node,
        "page": node,
        "content_object": content,
        "form": form,
        "initial_blocks": initial_blocks,
        "editor_config": {
            "nodeId": str(node.pk) if node else None,
            "version": content.version if content else 0,
            "saveUrl": save_url,
            "uploadUrl": reverse("wiki:asset_upload"),
            "moveTreeUrl": move_url,
            "publishUrl": publish_url,
            "unpublishUrl": unpublish_url,
            "csrfToken": get_token(request),
            "maxUploadBytes": MAX_UPLOAD_BYTES,
        },
        "tags": draft_meta.get("tags", list(node.tags.values_list("name", flat=True))) if node else [],
        "properties": _properties_for_template(properties),
        "parent_options": _parent_options(exclude=node),
        "available_tags": Tag.objects.all(),
        "page_templates": ("default", "weapon", "item", "system", "character", "location", "anomaly"),
    }


class EditorConflict(Exception):
    def __init__(self, content: PageContent):
        self.content = content
        super().__init__("다른 저장 내용이 있습니다.")


def _apply_editor_payload(node: WikiNode, payload: dict, actor, *, force_status: str | None = None):
    content, _ = PageContent.objects.get_or_create(node=node)
    content = PageContent.objects.select_for_update().get(pk=content.pk)
    requested_version = payload.get("version")
    if requested_version is not None:
        try:
            requested_version = int(requested_version)
        except (TypeError, ValueError) as exc:
            raise ValidationError("올바르지 않은 문서 버전입니다.") from exc
        if requested_version != content.version:
            raise EditorConflict(content)

    blocks = normalize_blocks(payload.get("blocks", content.blocks))
    properties = normalize_properties(payload.get("properties", content.properties))
    template = normalize_template(payload.get("template", content.template))
    pending = content.draft_meta if isinstance(content.draft_meta, dict) else {}
    title = pending.get("title", node.title)
    if "title" in payload:
        title = " ".join(str(payload.get("title") or "").split())[:180]
        if not title:
            raise ValidationError("페이지 제목을 입력해 주세요.")
    summary = pending.get("summary", node.summary)
    if "summary" in payload:
        summary = str(payload.get("summary") or "").strip()[:500]
    tags = _tag_names(payload.get("tags")) if "tags" in payload else pending.get(
        "tags", list(node.tags.values_list("name", flat=True))
    )
    parent_id = pending.get("parentId", str(node.parent_id) if node.parent_id else None)
    if "parent" in payload or "parentId" in payload or "parent_id" in payload:
        parent_id = payload.get("parent", payload.get("parentId", payload.get("parent_id")))
    if parent_id in (None, "", "null"):
        requested_parent = None
        parent_id = None
    else:
        try:
            requested_parent = WikiNode.objects.alive().get(pk=parent_id, kind=WikiNode.Kind.FOLDER)
            parent_id = str(requested_parent.pk)
        except (WikiNode.DoesNotExist, ValueError, TypeError) as exc:
            raise ValidationError("상위 폴더를 찾을 수 없습니다.") from exc

    promote = force_status == WikiNode.Status.PUBLISHED
    if node.status == WikiNode.Status.PUBLISHED and not promote:
        content.draft_meta = {
            "title": title,
            "summary": summary,
            "tags": tags,
            "parentId": parent_id,
        }
    else:
        old_parent_id = node.parent_id
        node.title = title
        node.summary = summary
        if force_status:
            node.status = force_status
        node.updated_by = actor
        node.save()
        _set_node_tags(node, tags)
        if (requested_parent.pk if requested_parent else None) != old_parent_id:
            node = move_node(node, new_parent=requested_parent, actor=actor)
        content.draft_meta = {}

    content.blocks = blocks
    content.properties = properties
    content.template = template
    content.version += 1
    content.search_text = build_search_text_values(
        title=title,
        summary=summary,
        tags=tags,
        blocks=blocks,
        properties=properties,
    )
    if promote:
        content.published_blocks = blocks
        content.published_properties = properties
        content.published_template = template
        content.published_search_text = content.search_text
    content.save()
    return node, content


def _conflict_response(conflict: EditorConflict):
    content = conflict.content
    return JsonResponse(
        {
            "ok": False,
            "error": "conflict",
            "errorMessage": "다른 저장 내용이 있어 저장하지 않았습니다.",
            "message": "다른 저장 내용이 있어 저장하지 않았습니다.",
            "version": content.version,
            "currentBlocks": content.blocks,
            "currentProperties": content.properties,
        },
        status=409,
    )


@require_GET
def home(request):
    public_only = not (request.user.is_authenticated and request.user.is_staff)
    roots = WikiNode.objects.alive().roots().select_related("parent").prefetch_related(_folder_prefetch(public_only=public_only))
    recent = WikiNode.objects.alive().filter(kind=WikiNode.Kind.PAGE).select_related("parent").prefetch_related("tags").order_by("-updated_at")
    if public_only:
        roots = roots.filter(status=WikiNode.Status.PUBLISHED)
        recent = recent.filter(status=WikiNode.Status.PUBLISHED)
        recent_pages = _public_candidates(recent[:50], limit=8)
    else:
        recent_pages = list(recent[:8])
    return render(request, "wiki/home.html", {"roots": roots, "topics": roots, "recent_pages": recent_pages})


@require_GET
def search(request):
    form = SearchForm(request.GET)
    query = ""
    results: list[WikiNode] = []
    if form.is_valid():
        query = form.cleaned_data["q"].strip()
    if query:
        queryset = (
            WikiNode.objects.alive()
            .select_related("parent", "content")
            .prefetch_related("tags")
            .filter(
                Q(title__icontains=query)
                | Q(summary__icontains=query)
                | Q(content__search_text__icontains=query)
                | Q(tags__name__icontains=query)
            )
            .distinct()
            .order_by("position", "title")
        )
        if not (request.user.is_authenticated and request.user.is_staff):
            queryset = (
                WikiNode.objects.alive()
                .select_related("parent", "content")
                .prefetch_related("tags")
                .filter(status=WikiNode.Status.PUBLISHED)
                .filter(
                    Q(title__icontains=query)
                    | Q(summary__icontains=query)
                    | Q(content__published_search_text__icontains=query)
                    | Q(tags__name__icontains=query)
                )
                .distinct()
                .order_by("position", "title")
            )
            results = _public_candidates(queryset[:200])
        else:
            results = list(queryset[:200])
    return render(request, "wiki/search.html", {"form": form, "query": query, "results": results})


@require_GET
def node_detail(request, node_id, slug):
    node = _node_for_view(request, node_id, include_deleted_for_staff=True)
    if slug != node.slug:
        return redirect(node.get_absolute_url(), permanent=True)
    staff = request.user.is_authenticated and request.user.is_staff
    children = node.children.alive().select_related("parent").prefetch_related("tags")
    if not staff:
        children = children.filter(status=WikiNode.Status.PUBLISHED)
        child_list = _public_candidates(children)
    else:
        child_list = list(children)
    content = None
    blocks = []
    display_properties = []
    display_template = "default"
    if node.kind == WikiNode.Kind.PAGE:
        try:
            content = node.content
        except PageContent.DoesNotExist:
            content = None
        selected_blocks = (content.blocks if staff else content.published_blocks) if content else []
        blocks = rendered_blocks(selected_blocks) if content else []
        if content:
            selected_properties = content.properties if staff else content.published_properties
            display_properties = _properties_for_template(selected_properties)
            display_template = content.template if staff else content.published_template
    ancestors = node.get_ancestors()
    return render(
        request,
        "wiki/node_detail.html",
        {
            "node": node,
            "current": node,
            "page": node,
            "ancestors": ancestors,
            "breadcrumbs": ancestors,
            "children": child_list,
            "content_object": content,
            "rendered_blocks": blocks,
            "properties": display_properties,
            "display_properties": display_properties,
            "page_template": display_template,
            "tags": node.tags.all(),
            "can_edit": staff,
            "is_preview": staff and not node.is_publicly_visible(),
        },
    )


@staff_required
@require_GET
def dashboard(request):
    alive = WikiNode.objects.alive()
    stats = {
        "total": alive.count(),
        "published": alive.filter(status=WikiNode.Status.PUBLISHED).count(),
        "drafts": alive.filter(status=WikiNode.Status.DRAFT).count(),
        "trash": WikiNode.objects.deleted().count(),
    }
    return render(
        request,
        "wiki/dashboard.html",
        {
            "stats": stats,
            "total_nodes": stats["total"],
            "published_count": stats["published"],
            "draft_count": stats["drafts"],
            "trash_count": stats["trash"],
            "recent_pages": alive.filter(kind=WikiNode.Kind.PAGE).select_related("parent").order_by("-updated_at")[:10],
            "recent_revisions": PageRevision.objects.select_related("page__node", "created_by")[:8],
        },
    )


@staff_required
@require_http_methods(["GET", "POST"])
def editor(request):
    """Create a page directly in the rich editor."""
    if request.method == "POST" and request.content_type == "application/json":
        try:
            payload = _json_payload(request)
            title = " ".join(str(payload.get("title") or "").split())[:180]
            if not title:
                raise ValidationError("페이지 제목을 입력해 주세요.")
            parent_id = payload.get("parent", payload.get("parentId", payload.get("parent_id")))
            if parent_id in (None, "", "null"):
                parent = None
            else:
                try:
                    parent = WikiNode.objects.alive().get(pk=parent_id, kind=WikiNode.Kind.FOLDER)
                except (WikiNode.DoesNotExist, ValueError, TypeError) as exc:
                    raise ValidationError("상위 폴더를 찾을 수 없습니다.") from exc
            blocks = normalize_blocks(payload.get("blocks", []))
            properties = normalize_properties(payload.get("properties", {}))
            template = normalize_template(payload.get("template", "default"))
            should_publish = bool(payload.get("publish")) or payload.get("status") == WikiNode.Status.PUBLISHED
            with transaction.atomic():
                node = WikiNode.objects.create(
                    kind=WikiNode.Kind.PAGE,
                    title=title,
                    summary=str(payload.get("summary") or "").strip()[:500],
                    parent=parent,
                    position=next_position(parent),
                    status=WikiNode.Status.PUBLISHED if should_publish else WikiNode.Status.DRAFT,
                    created_by=request.user,
                    updated_by=request.user,
                )
                _set_node_tags(node, payload.get("tags", []))
                content = PageContent.objects.create(
                    node=node,
                    blocks=blocks,
                    properties=properties,
                    template=template,
                    published_blocks=blocks if should_publish else [],
                    published_properties=properties if should_publish else {},
                    published_template=template if should_publish else "default",
                )
                content.search_text = build_search_text(node, blocks, properties)
                if should_publish:
                    content.published_search_text = content.search_text
                content.save(update_fields=("search_text", "published_search_text", "updated_at"))
                create_revision(content, request.user, "문서 생성")
            return JsonResponse(
                {
                    "ok": True,
                    "created": True,
                    "isNew": True,
                    "nodeId": str(node.pk),
                    "version": content.version,
                    "savedAt": content.updated_at.isoformat(),
                    "status": node.status,
                    "redirectUrl": node.get_absolute_url()
                    if should_publish
                    else reverse("wiki:node_edit", kwargs={"node_id": node.pk}),
                },
                status=201,
            )
        except (ValidationError, ValueError, TypeError) as error:
            return _error_response(request, error)

    form = PageEditorForm(request.POST or None, node=None, initial={"parent": request.GET.get("parent")})
    if request.method == "POST" and form.is_valid():
        try:
            blocks, properties, template = _editor_post_content(request)
        except ValidationError as error:
            form.add_error(None, error)
        else:
            with transaction.atomic():
                action = request.POST.get("action", "draft")
                node = WikiNode.objects.create(
                    kind=WikiNode.Kind.PAGE,
                    title=form.cleaned_data["title"],
                    summary=form.cleaned_data["summary"],
                    parent=form.cleaned_data["parent"],
                    position=next_position(form.cleaned_data["parent"]),
                    status=WikiNode.Status.PUBLISHED if action == "publish" else WikiNode.Status.DRAFT,
                    created_by=request.user,
                    updated_by=request.user,
                )
                _set_node_tags(node, form.cleaned_data.get("tags"))
                content = PageContent.objects.create(
                    node=node,
                    blocks=blocks,
                    properties=properties,
                    template=template,
                    published_blocks=blocks if node.status == WikiNode.Status.PUBLISHED else [],
                    published_properties=properties if node.status == WikiNode.Status.PUBLISHED else {},
                    published_template=template if node.status == WikiNode.Status.PUBLISHED else "default",
                )
                content.search_text = build_search_text(node, blocks, properties)
                if node.status == WikiNode.Status.PUBLISHED:
                    content.published_search_text = content.search_text
                content.save(update_fields=("search_text", "published_search_text", "updated_at"))
                create_revision(content, request.user, "문서 생성")
            messages.success(request, "새 페이지를 만들었습니다.")
            return redirect("wiki:node_edit", node_id=node.pk)
    return render(request, "wiki/editor.html", _editor_context(request, node=None, content=None, form=form))


@staff_required
@require_http_methods(["GET", "POST"])
def node_create(request):
    kind = request.GET.get("kind", WikiNode.Kind.FOLDER)
    if kind not in WikiNode.Kind.values:
        kind = WikiNode.Kind.FOLDER
    data = None
    if request.method == "POST":
        data = request.POST.copy()
        data["kind"] = kind
        data.setdefault("slug", "")
    form = WikiNodeForm(data=data, initial={"kind": kind, "parent": request.GET.get("parent")})
    if request.method == "POST" and form.is_valid():
        with transaction.atomic():
            node = form.save(commit=False)
            node.position = next_position(node.parent)
            node.created_by = request.user
            node.updated_by = request.user
            node.save()
            form.save_m2m()
            if node.kind == WikiNode.Kind.PAGE:
                PageContent.objects.create(node=node)
        messages.success(request, "새 항목을 만들었습니다.")
        if node.kind == WikiNode.Kind.PAGE:
            return redirect("wiki:node_edit", node_id=node.pk)
        return redirect("wiki:structure")
    return render(
        request,
        "wiki/node_form.html",
        {"form": form, "node": None, "parent_options": _parent_options(), "kind": kind},
    )


@staff_required
@require_http_methods(["GET", "POST"])
def node_edit(request, node_id):
    node = get_object_or_404(WikiNode.objects.alive().prefetch_related("tags"), pk=node_id)
    if node.kind == WikiNode.Kind.FOLDER:
        original_parent = node.parent
        data = None
        if request.method == "POST":
            data = request.POST.copy()
            data["kind"] = node.kind
            data["slug"] = node.slug
            data.setlist("tags", [str(pk) for pk in node.tags.values_list("pk", flat=True)])
        form = WikiNodeForm(data=data, instance=node)
        if request.method == "POST" and form.is_valid():
            requested_parent = form.cleaned_data["parent"]
            with transaction.atomic():
                changed = form.save(commit=False)
                changed.parent = original_parent
                changed.updated_by = request.user
                changed.save()
                form.save_m2m()
                if (requested_parent.pk if requested_parent else None) != (original_parent.pk if original_parent else None):
                    changed = move_node(changed, new_parent=requested_parent, actor=request.user)
            messages.success(request, "폴더 설정을 저장했습니다.")
            return redirect(changed.get_absolute_url())
        return render(
            request,
            "wiki/node_form.html",
            {"form": form, "node": node, "parent_options": _parent_options(exclude=node)},
        )

    content, _ = PageContent.objects.get_or_create(node=node)
    initial = {
        "title": node.title,
        "summary": node.summary,
        "parent": node.parent,
        "template": content.template,
        "tags": ", ".join(node.tags.values_list("name", flat=True)),
    }
    form = PageEditorForm(request.POST or None, node=node, initial=initial)
    if request.method == "POST" and form.is_valid():
        try:
            blocks, properties, template = _editor_post_content(request, current=content)
        except ValidationError as error:
            form.add_error(None, error)
        else:
            with transaction.atomic():
                locked_node = WikiNode.objects.select_for_update().get(pk=node.pk)
                action = request.POST.get("action", "draft")
                payload = {
                    "title": form.cleaned_data["title"],
                    "summary": form.cleaned_data["summary"],
                    "parent": str(form.cleaned_data["parent"].pk) if form.cleaned_data["parent"] else None,
                    "tags": form.cleaned_data.get("tags"),
                    "blocks": blocks,
                    "properties": properties,
                    "template": template,
                    "version": content.version,
                }
                locked_node, locked_content = _apply_editor_payload(
                    locked_node,
                    payload,
                    request.user,
                    force_status=WikiNode.Status.PUBLISHED if action == "publish" else None,
                )
                if action == "publish":
                    create_revision(locked_content, request.user, "문서 게시")
            messages.success(request, "문서를 저장했습니다.")
            return redirect(locked_node.get_absolute_url())
    return render(request, "wiki/editor.html", _editor_context(request, node=node, content=content, form=form))


@staff_required
@require_GET
def structure(request):
    roots = WikiNode.objects.alive().roots().prefetch_related(_folder_prefetch())
    all_nodes = WikiNode.objects.alive().select_related("parent").order_by("position", "title")
    return render(
        request,
        "wiki/structure.html",
        {"roots": roots, "all_nodes": all_nodes, "tree": build_tree(all_nodes)},
    )


@staff_required
@require_GET
def trash(request):
    deleted = list(WikiNode.objects.deleted().select_related("parent", "deleted_by").order_by("-deleted_at"))
    trash_nodes = [
        node
        for node in deleted
        if node.parent is None
        or not node.parent.is_deleted
        or node.parent.deletion_batch != node.deletion_batch
    ]
    return render(request, "wiki/trash.html", {"trash_nodes": trash_nodes, "deleted_nodes": deleted})


@staff_required
@require_GET
def revisions(request, node_id):
    node = get_object_or_404(WikiNode.objects.alive(), pk=node_id, kind=WikiNode.Kind.PAGE)
    content, _ = PageContent.objects.get_or_create(node=node)
    revision_list = content.revisions.select_related("created_by")
    return render(
        request,
        "wiki/revisions.html",
        {"node": node, "current": node, "page": node, "content_object": content, "revisions": revision_list},
    )


@staff_required
@require_POST
def autosave(request, node_id):
    try:
        payload = _json_payload(request)
        with transaction.atomic():
            node = get_object_or_404(WikiNode.objects.select_for_update().alive(), pk=node_id, kind=WikiNode.Kind.PAGE)
            node, content = _apply_editor_payload(node, payload, request.user)
        return JsonResponse(
            {
                "ok": True,
                "nodeId": str(node.pk),
                "version": content.version,
                "savedAt": content.updated_at.isoformat(),
                "searchText": content.search_text,
                "status": node.status,
            }
        )
    except EditorConflict as conflict:
        return _conflict_response(conflict)
    except (ValidationError, ValueError, TypeError) as error:
        return _error_response(request, error)


@staff_required
@require_POST
def publish(request, node_id):
    try:
        with transaction.atomic():
            node = get_object_or_404(WikiNode.objects.select_for_update().alive(), pk=node_id)
            if request.content_type == "application/json" and node.kind == WikiNode.Kind.PAGE:
                payload = _json_payload(request)
                if not str(payload.get("title", node.title) or "").strip():
                    raise ValidationError("게시하려면 페이지 제목을 입력해 주세요.")
                node, content = _apply_editor_payload(
                    node,
                    payload,
                    request.user,
                    force_status=WikiNode.Status.PUBLISHED,
                )
            else:
                if node.kind == WikiNode.Kind.PAGE:
                    content, _ = PageContent.objects.get_or_create(node=node)
                    draft_meta = content.draft_meta if isinstance(content.draft_meta, dict) else {}
                    payload = {
                        "title": draft_meta.get("title", node.title),
                        "summary": draft_meta.get("summary", node.summary),
                        "parent": draft_meta.get("parentId", str(node.parent_id) if node.parent_id else None),
                        "tags": draft_meta.get("tags", list(node.tags.values_list("name", flat=True))),
                        "blocks": content.blocks,
                        "properties": content.properties,
                        "template": content.template,
                        "version": content.version,
                    }
                    node, content = _apply_editor_payload(
                        node,
                        payload,
                        request.user,
                        force_status=WikiNode.Status.PUBLISHED,
                    )
                else:
                    node.status = WikiNode.Status.PUBLISHED
                    node.published_at = node.published_at or timezone.now()
                    node.updated_by = request.user
                    node.save()
                    content = None
            if content:
                create_revision(content, request.user, "게시")
        if _wants_json(request):
            return JsonResponse(
                {
                    "ok": True,
                    "nodeId": str(node.pk),
                    "status": node.status,
                    "version": content.version if content else None,
                    "savedAt": content.updated_at.isoformat() if content else node.updated_at.isoformat(),
                    "redirectUrl": node.get_absolute_url(),
                    "url": node.get_absolute_url(),
                    "message": "문서를 공개했습니다.",
                }
            )
        return _action_response(request, node, "문서를 공개했습니다.")
    except EditorConflict as conflict:
        return _conflict_response(conflict)
    except (ValidationError, ValueError, TypeError) as error:
        return _error_response(request, error)


@staff_required
@require_POST
def unpublish(request, node_id):
    with transaction.atomic():
        node = get_object_or_404(WikiNode.objects.select_for_update().alive(), pk=node_id)
        node.status = WikiNode.Status.DRAFT
        node.updated_by = request.user
        node.save()
        if node.kind == WikiNode.Kind.PAGE:
            content, _ = PageContent.objects.get_or_create(node=node)
            create_revision(content, request.user, "비공개 전환")
    return _action_response(request, node, "문서를 초안으로 전환했습니다.")


@staff_required
@require_POST
def node_move(request, node_id):
    try:
        payload = _json_payload(request) if request.content_type == "application/json" else request.POST.dict()
        node = get_object_or_404(WikiNode.objects.alive(), pk=node_id)
        parent_keys = ("newParentId", "parentId", "new_parent_id", "parent_id")
        parent_specified = any(key in payload for key in parent_keys)
        parent_id = next((payload.get(key) for key in parent_keys if key in payload), None)
        if parent_specified:
            new_parent = None if parent_id in (None, "", "null") else get_object_or_404(WikiNode.objects.alive(), pk=parent_id)
        else:
            new_parent = node.parent
        moved = move_node(
            node,
            new_parent=new_parent,
            before_id=payload.get("beforeId") or payload.get("before_id"),
            after_id=payload.get("afterId") or payload.get("after_id"),
            position=payload.get("position", payload.get("newIndex")),
            actor=request.user,
        )
        return JsonResponse(
            {
                "ok": True,
                "nodeId": str(moved.pk),
                "parentId": str(moved.parent_id) if moved.parent_id else None,
                "position": moved.position,
            }
        )
    except (ValidationError, ValueError, TypeError) as error:
        return _error_response(request, error)


@staff_required
@require_POST
def node_delete(request, node_id):
    node = get_object_or_404(WikiNode.objects.alive(), pk=node_id)
    batch = soft_delete_subtree(node, request.user)
    if _wants_json(request):
        return JsonResponse({"ok": True, "nodeId": str(node.pk), "deletionBatch": str(batch)})
    messages.success(request, "항목을 휴지통으로 이동했습니다.")
    return redirect("wiki:trash")


@staff_required
@require_POST
def node_restore(request, node_id):
    node = get_object_or_404(WikiNode.objects.deleted(), pk=node_id)
    restored = restore_deleted_node(node, request.user)
    node.refresh_from_db()
    if _wants_json(request):
        return JsonResponse({"ok": True, "nodeId": str(node.pk), "restored": restored, "url": node.get_absolute_url()})
    messages.success(request, f"{restored}개 항목을 복원했습니다.")
    return redirect("wiki:trash")


@staff_required
@require_POST
def node_purge(request, node_id):
    node = get_object_or_404(WikiNode.objects.deleted(), pk=node_id)
    title = node.title
    node.delete()
    if _wants_json(request):
        return JsonResponse({"ok": True, "nodeId": str(node_id)})
    messages.success(request, f"{title} 항목을 영구 삭제했습니다.")
    return redirect("wiki:trash")


@staff_required
@require_POST
def revision_restore(request, node_id, revision_id):
    with transaction.atomic():
        node = get_object_or_404(WikiNode.objects.select_for_update().alive(), pk=node_id, kind=WikiNode.Kind.PAGE)
        page = get_object_or_404(PageContent.objects.select_for_update(), node=node)
        revision = get_object_or_404(PageRevision, pk=revision_id, page=page)
        create_revision(page, request.user, f"r{revision.number} 복원 전 백업")
        page.blocks = normalize_blocks(revision.blocks)
        page.properties = normalize_properties(revision.properties)
        page.template = normalize_template(revision.template)
        restored_tags = _tag_names(revision.tags)
        if node.status == WikiNode.Status.PUBLISHED:
            page.draft_meta = {
                "title": revision.title,
                "summary": revision.summary,
                "tags": restored_tags,
                "parentId": str(revision.parent_node_id) if revision.parent_node_id else None,
            }
        else:
            node.title = revision.title
            node.summary = revision.summary
            node.updated_by = request.user
            node.save()
            _set_node_tags(node, restored_tags)
            if revision.parent_node_id != node.parent_id:
                target_parent = WikiNode.objects.alive().filter(
                    pk=revision.parent_node_id,
                    kind=WikiNode.Kind.FOLDER,
                ).first()
                if target_parent or revision.parent_node_id is None:
                    node = move_node(node, new_parent=target_parent, actor=request.user)
            page.draft_meta = {}
        page.version += 1
        page.search_text = build_search_text_values(
            title=revision.title,
            summary=page.draft_meta.get("summary", node.summary),
            tags=restored_tags,
            blocks=page.blocks,
            properties=page.properties,
        )
        page.save()
        restored_revision = create_revision(page, request.user, f"r{revision.number}에서 복원")
        restored_revision.title = revision.title
        restored_revision.summary = revision.summary
        restored_revision.parent_node_id = revision.parent_node_id
        restored_revision.tags = restored_tags
        restored_revision.status = WikiNode.Status.DRAFT
        restored_revision.save(update_fields=("title", "summary", "parent_node_id", "tags", "status"))
    if _wants_json(request):
        return JsonResponse(
            {"ok": True, "nodeId": str(node.pk), "revisionId": str(restored_revision.pk), "version": page.version}
        )
    messages.success(request, f"리비전 {revision.number} 상태로 복원했습니다.")
    return redirect("wiki:node_edit", node_id=node.pk)


@staff_required
@require_POST
def asset_upload(request):
    form = AssetUploadForm(request.POST, request.FILES)
    if not form.is_valid():
        error_message = " ".join(sum(form.errors.values(), []))
        return JsonResponse(
            {"ok": False, "error": error_message, "code": "validation_error", "message": error_message},
            status=400,
        )
    upload = form.cleaned_data["upload"]
    try:
        prepared_file, mime_type, width, height, digest = prepare_image_upload(upload)
    except ValidationError as error:
        return _error_response(request, error)
    asset = Asset.objects.create(
        node=form.cleaned_data["node"],
        file=prepared_file,
        original_name=Path(upload.name).name[:255],
        mime_type=mime_type,
        size=prepared_file.size,
        width=width,
        height=height,
        sha256=digest,
        alt_text=form.cleaned_data.get("alt_text", ""),
        caption=form.cleaned_data.get("caption", ""),
        uploaded_by=request.user,
    )
    return JsonResponse(
        {
            "ok": True,
            "asset": {
                "id": str(asset.pk),
                "url": asset.file.url,
                "name": asset.original_name,
                "mimeType": asset.mime_type,
                "size": asset.size,
                "width": asset.width,
                "height": asset.height,
                "altText": asset.alt_text,
            },
        },
        status=201,
    )
