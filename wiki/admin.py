from django.contrib import admin

from .models import Asset, PageContent, PageRevision, Tag, WikiNode
from .services import restore_deleted_node, soft_delete_subtree


class PageContentInline(admin.StackedInline):
    model = PageContent
    extra = 0
    max_num = 1
    fields = ("template", "version", "properties", "blocks", "search_text", "updated_at")
    readonly_fields = ("version", "search_text", "updated_at")

    def has_add_permission(self, request, obj=None):
        return bool(obj and obj.kind == WikiNode.Kind.PAGE and not hasattr(obj, "content"))


@admin.register(WikiNode)
class WikiNodeAdmin(admin.ModelAdmin):
    list_display = ("title", "kind", "parent", "status", "position", "is_deleted", "updated_at")
    list_filter = ("kind", "status", "is_deleted", "created_at", "updated_at")
    search_fields = ("title", "summary", "slug", "content__search_text", "tags__name")
    autocomplete_fields = ("parent", "tags", "created_by", "updated_by", "deleted_by")
    readonly_fields = ("id", "created_at", "updated_at", "published_at", "deleted_at", "deletion_batch")
    ordering = ("parent", "position", "title")
    inlines = (PageContentInline,)
    actions = ("publish_selected", "draft_selected", "soft_delete_selected", "restore_selected")

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("parent")

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.action(description="선택 항목 게시")
    def publish_selected(self, request, queryset):
        updated = 0
        for node in queryset.filter(is_deleted=False):
            if node.kind == WikiNode.Kind.PAGE:
                content, _ = PageContent.objects.get_or_create(node=node)
                if node.status == WikiNode.Status.PUBLISHED and content.draft_meta:
                    continue
                content.published_blocks = content.blocks
                content.published_properties = content.properties
                content.published_template = content.template
                content.published_search_text = content.search_text
                content.save(
                    update_fields=(
                        "published_blocks",
                        "published_properties",
                        "published_template",
                        "published_search_text",
                        "updated_at",
                    )
                )
            node.status = WikiNode.Status.PUBLISHED
            node.updated_by = request.user
            node.save()
            updated += 1
        self.message_user(request, f"{updated}개 항목을 게시했습니다.")

    @admin.action(description="선택 항목을 초안으로 전환")
    def draft_selected(self, request, queryset):
        updated = queryset.filter(is_deleted=False).update(status=WikiNode.Status.DRAFT)
        self.message_user(request, f"{updated}개 항목을 초안으로 전환했습니다.")

    @admin.action(description="선택 항목과 하위 항목을 휴지통으로 이동")
    def soft_delete_selected(self, request, queryset):
        count = 0
        for node in queryset.filter(is_deleted=False):
            soft_delete_subtree(node, request.user)
            count += 1
        self.message_user(request, f"{count}개 트리를 휴지통으로 이동했습니다.")

    @admin.action(description="선택 삭제 묶음 복원")
    def restore_selected(self, request, queryset):
        restored = 0
        batches = set()
        for node in queryset.filter(is_deleted=True):
            key = node.deletion_batch or node.pk
            if key in batches:
                continue
            batches.add(key)
            restored += restore_deleted_node(node, request.user)
        self.message_user(request, f"{restored}개 항목을 복원했습니다.")


@admin.register(PageContent)
class PageContentAdmin(admin.ModelAdmin):
    list_display = ("node", "template", "version", "updated_at")
    list_filter = ("template", "updated_at")
    search_fields = ("node__title", "search_text")
    autocomplete_fields = ("node",)
    readonly_fields = ("version", "search_text", "created_at", "updated_at")


@admin.register(PageRevision)
class PageRevisionAdmin(admin.ModelAdmin):
    list_display = ("page", "number", "status", "reason", "created_by", "created_at")
    list_filter = ("status", "created_at")
    search_fields = ("page__node__title", "title", "reason")
    autocomplete_fields = ("page", "created_by")
    readonly_fields = (
        "id",
        "page",
        "number",
        "title",
        "summary",
        "parent_node_id",
        "blocks",
        "properties",
        "template",
        "status",
        "tags",
        "reason",
        "created_by",
        "created_at",
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Tag)
class TagAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "color", "created_at")
    search_fields = ("name", "slug")
    prepopulated_fields = {"slug": ("name",)}


@admin.register(Asset)
class AssetAdmin(admin.ModelAdmin):
    list_display = ("original_name", "node", "mime_type", "size", "width", "height", "is_deleted", "created_at")
    list_filter = ("mime_type", "is_deleted", "created_at")
    search_fields = ("original_name", "alt_text", "caption", "sha256", "node__title")
    autocomplete_fields = ("node", "uploaded_by")
    readonly_fields = ("id", "mime_type", "size", "width", "height", "sha256", "created_at")
