from __future__ import annotations

import uuid
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.urls import reverse
from django.utils import timezone
from django.utils.text import slugify


class Tag(models.Model):
    name = models.CharField(max_length=50, unique=True)
    slug = models.SlugField(max_length=60, unique=True, allow_unicode=True, blank=True)
    color = models.CharField(max_length=7, default="#64748b")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("name",)

    def __str__(self) -> str:
        return self.name

    def save(self, *args, **kwargs):
        if not self.slug:
            base = slugify(self.name, allow_unicode=True) or uuid.uuid4().hex[:8]
            candidate = base
            index = 2
            while Tag.objects.exclude(pk=self.pk).filter(slug=candidate).exists():
                candidate = f"{base}-{index}"
                index += 1
            self.slug = candidate
        super().save(*args, **kwargs)


class WikiNodeQuerySet(models.QuerySet):
    def alive(self):
        return self.filter(is_deleted=False)

    def deleted(self):
        return self.filter(is_deleted=True)

    def published(self):
        return self.alive().filter(status=WikiNode.Status.PUBLISHED)

    def roots(self):
        return self.filter(parent__isnull=True)


class WikiNode(models.Model):
    class Kind(models.TextChoices):
        FOLDER = "folder", "폴더"
        PAGE = "page", "페이지"

    class Status(models.TextChoices):
        DRAFT = "draft", "초안"
        PUBLISHED = "published", "게시됨"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    parent = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="children",
    )
    kind = models.CharField(max_length=12, choices=Kind.choices, default=Kind.PAGE)
    title = models.CharField(max_length=180)
    slug = models.SlugField(max_length=200, allow_unicode=True, blank=True, db_index=True)
    summary = models.TextField(blank=True, max_length=500)
    position = models.PositiveIntegerField(default=0, db_index=True)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.DRAFT, db_index=True)
    tags = models.ManyToManyField(Tag, blank=True, related_name="nodes")

    is_deleted = models.BooleanField(default=False, db_index=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    deletion_batch = models.UUIDField(null=True, blank=True, editable=False, db_index=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="deleted_wiki_nodes",
    )
    published_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="created_wiki_nodes",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="updated_wiki_nodes",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = WikiNodeQuerySet.as_manager()

    class Meta:
        ordering = ("position", "title", "id")
        indexes = [
            models.Index(fields=("parent", "is_deleted", "position")),
            models.Index(fields=("kind", "status", "is_deleted")),
            models.Index(fields=("-updated_at",)),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(position__gte=0),
                name="wiki_node_position_nonnegative",
            )
        ]

    def __str__(self) -> str:
        return self.title

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = slugify(self.title, allow_unicode=True) or self.id.hex[:12]
        if self.status == self.Status.PUBLISHED and self.published_at is None:
            self.published_at = timezone.now()
        super().save(*args, **kwargs)

    def clean(self):
        super().clean()
        if self.parent_id == self.pk:
            raise ValidationError({"parent": "자기 자신을 상위 항목으로 지정할 수 없습니다."})
        if self.parent_id and self.parent and self.parent.kind != self.Kind.FOLDER:
            raise ValidationError({"parent": "페이지 아래에는 항목을 만들 수 없습니다."})
        if self.parent_id:
            ancestor = self.parent
            visited = {self.pk}
            while ancestor is not None:
                if ancestor.pk in visited:
                    raise ValidationError({"parent": "순환 계층 구조를 만들 수 없습니다."})
                visited.add(ancestor.pk)
                ancestor = ancestor.parent

    def get_absolute_url(self) -> str:
        return reverse("wiki:node_detail", kwargs={"node_id": self.pk, "slug": self.slug})

    def get_node_type_display(self) -> str:
        return self.get_kind_display()

    def get_ancestors(self, include_self: bool = False) -> list["WikiNode"]:
        ancestors: list[WikiNode] = [self] if include_self else []
        node = self.parent
        visited = {self.pk}
        while node is not None and node.pk not in visited:
            visited.add(node.pk)
            ancestors.append(node)
            node = node.parent
        if include_self:
            current = ancestors.pop(0)
            ancestors.reverse()
            ancestors.append(current)
            return ancestors
        ancestors.reverse()
        return ancestors

    def is_publicly_visible(self) -> bool:
        if self.is_deleted or self.status != self.Status.PUBLISHED:
            return False
        return all(
            not ancestor.is_deleted and ancestor.status == self.Status.PUBLISHED
            for ancestor in self.get_ancestors()
        )


class PageContent(models.Model):
    node = models.OneToOneField(WikiNode, on_delete=models.CASCADE, related_name="content")
    # Working copy. Staff edits always target these fields.
    blocks = models.JSONField(default=list, blank=True)
    properties = models.JSONField(default=dict, blank=True)
    template = models.CharField(max_length=50, default="default")
    search_text = models.TextField(blank=True)
    # Public snapshot. Published pages are rendered and searched from these fields.
    published_blocks = models.JSONField(default=list, blank=True)
    published_properties = models.JSONField(default=dict, blank=True)
    published_template = models.CharField(max_length=50, default="default")
    published_search_text = models.TextField(blank=True)
    # Pending title/summary/tags/parent changes for an already-published page.
    draft_meta = models.JSONField(default=dict, blank=True)
    version = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("node__title",)

    def __str__(self) -> str:
        return f"{self.node.title} 콘텐츠"

    def clean(self):
        super().clean()
        if self.node_id and self.node.kind != WikiNode.Kind.PAGE:
            raise ValidationError({"node": "페이지 노드에만 콘텐츠를 연결할 수 있습니다."})


class PageRevision(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    page = models.ForeignKey(PageContent, on_delete=models.CASCADE, related_name="revisions")
    number = models.PositiveIntegerField()
    title = models.CharField(max_length=180)
    summary = models.TextField(blank=True, max_length=500)
    parent_node_id = models.UUIDField(null=True, blank=True)
    blocks = models.JSONField(default=list)
    properties = models.JSONField(default=dict)
    template = models.CharField(max_length=50, default="default")
    status = models.CharField(max_length=12, choices=WikiNode.Status.choices)
    tags = models.JSONField(default=list, blank=True)
    reason = models.CharField(max_length=120, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="wiki_revisions",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at", "-number")
        constraints = [
            models.UniqueConstraint(fields=("page", "number"), name="unique_page_revision_number")
        ]

    def __str__(self) -> str:
        return f"{self.page.node.title} r{self.number}"

    @property
    def author(self):
        return self.created_by

    @property
    def change_note(self) -> str:
        return self.reason

def asset_upload_path(instance: "Asset", filename: str) -> str:
    extension = Path(filename).suffix.lower()[:10]
    return f"wiki/{instance.id.hex[:2]}/{instance.id}{extension}"


class Asset(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    node = models.ForeignKey(
        WikiNode,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="assets",
    )
    file = models.ImageField(upload_to=asset_upload_path, width_field="width", height_field="height")
    original_name = models.CharField(max_length=255)
    mime_type = models.CharField(max_length=80)
    size = models.PositiveBigIntegerField(default=0)
    width = models.PositiveIntegerField(default=0)
    height = models.PositiveIntegerField(default=0)
    sha256 = models.CharField(max_length=64, db_index=True)
    alt_text = models.CharField(max_length=240, blank=True)
    caption = models.CharField(max_length=500, blank=True)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="wiki_assets",
    )
    is_deleted = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)

    def __str__(self) -> str:
        return self.original_name
