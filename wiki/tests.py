import io
import json

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse
from PIL import Image

from .models import Asset, PageContent, PageRevision, WikiNode
from .services import canonicalize_google_sheet, canonicalize_youtube_url, move_node, normalize_blocks


class WikiTestCase(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_user(
            username="operator",
            password="test-password-123",
            is_staff=True,
            is_superuser=True,
        )
        self.root = WikiNode.objects.create(
            kind=WikiNode.Kind.FOLDER,
            title="무기",
            status=WikiNode.Status.PUBLISHED,
            created_by=self.admin,
        )

    def make_page(self, *, title="M4A1", status=WikiNode.Status.DRAFT, parent=None):
        node = WikiNode.objects.create(
            kind=WikiNode.Kind.PAGE,
            title=title,
            parent=parent or self.root,
            status=status,
            created_by=self.admin,
        )
        content = PageContent.objects.create(node=node)
        return node, content

    def post_json(self, url, payload):
        return self.client.post(url, data=json.dumps(payload), content_type="application/json")


class PublicAccessTests(WikiTestCase):
    def test_public_can_read_published_but_not_draft(self):
        published, published_content = self.make_page(title="공개 무기", status=WikiNode.Status.PUBLISHED)
        published_content.published_blocks = [
            {"id": "public", "type": "rich_text", "data": {"html": "<p>공개 데이터</p>"}}
        ]
        published_content.save()
        draft, _ = self.make_page(title="비밀 초안")

        response = self.client.get(published.get_absolute_url())
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "공개 데이터")
        self.assertEqual(self.client.get(draft.get_absolute_url()).status_code, 404)

    def test_deleted_and_draft_nodes_are_absent_from_navigation(self):
        draft, _ = self.make_page(title="숨은 초안")
        deleted, _ = self.make_page(title="삭제 문서", status=WikiNode.Status.PUBLISHED)
        deleted.is_deleted = True
        deleted.save(update_fields=("is_deleted",))

        response = self.client.get(reverse("wiki:home"))
        self.assertNotContains(response, draft.title)
        self.assertNotContains(response, deleted.title)

    def test_management_requires_staff_login(self):
        response = self.client.get(reverse("wiki:dashboard"))
        self.assertEqual(response.status_code, 302)
        self.assertIn(reverse("wiki:login"), response.url)

    def test_repeated_failed_logins_are_throttled(self):
        for _ in range(6):
            response = self.client.post(
                reverse("wiki:login"),
                {"username": self.admin.username, "password": "wrong-password"},
            )
            self.assertEqual(response.status_code, 200)
        blocked = self.client.post(
            reverse("wiki:login"),
            {"username": self.admin.username, "password": "wrong-password"},
        )
        self.assertEqual(blocked.status_code, 429)
        self.assertContains(blocked, "15분", status_code=429)


class EditorWorkflowTests(WikiTestCase):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.admin)

    def test_json_create_sanitizes_rich_content_and_supports_embeds(self):
        payload = {
            "title": "이상 현상 소총",
            "parent": str(self.root.pk),
            "summary": "테스트 문서",
            "template": "anomaly",
            "tags": ["이상 현상", "AR"],
            "properties": {"위험 등급": "III"},
            "blocks": [
                {
                    "id": "text",
                    "type": "text",
                    "data": {"html": '<p style="color:#fff" onclick="alert(1)">안전<script>alert(1)</script></p>'},
                },
                {
                    "id": "callout",
                    "type": "callout",
                    "data": {"tone": "warning", "title": "경고", "html": "<p>접촉 금지</p>"},
                },
                {"id": "video", "type": "youtube", "data": {"url": "https://youtu.be/dQw4w9WgXcQ?t=12"}},
                {
                    "id": "sheet",
                    "type": "sheet",
                    "data": {
                        "url": "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz1234567890/edit#gid=42",
                        "range": "A1:H30",
                    },
                },
            ],
        }
        response = self.post_json(reverse("wiki:editor"), payload)
        self.assertEqual(response.status_code, 201, response.content)
        node = WikiNode.objects.get(pk=response.json()["nodeId"])
        content = node.content
        rich_html = content.blocks[0]["data"]["html"]
        self.assertNotIn("script", rich_html.lower())
        self.assertNotIn("onclick", rich_html.lower())
        self.assertIn("안전", rich_html)
        self.assertEqual(content.blocks[1]["type"], "callout")
        self.assertEqual(content.blocks[2]["data"]["videoId"], "dQw4w9WgXcQ")
        self.assertEqual(content.blocks[3]["data"]["range"], "A1:H30")

    def test_staff_management_pages_render(self):
        node, _ = self.make_page()
        urls = [
            reverse("wiki:dashboard"),
            reverse("wiki:editor"),
            reverse("wiki:structure"),
            reverse("wiki:trash"),
            reverse("wiki:node_create"),
            reverse("wiki:node_edit", args=[node.pk]),
            reverse("wiki:revisions", args=[node.pk]),
        ]
        for url in urls:
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200, response.content[:500])

    def test_published_snapshot_is_not_changed_by_autosave(self):
        node, content = self.make_page(title="공개 제목", status=WikiNode.Status.PUBLISHED)
        public_blocks = [{"id": "old", "type": "rich_text", "data": {"html": "<p>공개 본문</p>"}}]
        content.blocks = public_blocks
        content.published_blocks = public_blocks
        content.search_text = "공개 제목 공개 본문"
        content.published_search_text = content.search_text
        content.save()

        response = self.post_json(
            reverse("wiki:autosave", args=[node.pk]),
            {
                "version": content.version,
                "title": "비공개 수정 제목",
                "summary": "아직 공개하면 안 됨",
                "blocks": [{"id": "new", "type": "text", "data": {"html": "<p>비밀 수정</p>"}}],
                "properties": {},
                "template": "weapon",
                "tags": ["검토 중"],
                "parent": str(self.root.pk),
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        node.refresh_from_db()
        content.refresh_from_db()
        self.assertEqual(node.title, "공개 제목")
        self.assertEqual(content.published_blocks, public_blocks)
        self.assertEqual(content.draft_meta["title"], "비공개 수정 제목")

        self.client.logout()
        public_response = self.client.get(node.get_absolute_url())
        self.assertContains(public_response, "공개 본문")
        self.assertNotContains(public_response, "비밀 수정")
        self.assertNotContains(public_response, "비공개 수정 제목")

    def test_publish_promotes_draft_and_creates_revision(self):
        node, content = self.make_page(title="공개 제목", status=WikiNode.Status.PUBLISHED)
        content.published_blocks = [{"id": "old", "type": "rich_text", "data": {"html": "<p>구버전</p>"}}]
        content.save()
        payload = {
            "version": content.version,
            "title": "승격 제목",
            "summary": "승격 요약",
            "blocks": [{"id": "new", "type": "text", "data": {"html": "<p>신버전</p>"}}],
            "properties": {"RPM": 720},
            "template": "weapon",
            "tags": ["확정"],
            "parent": str(self.root.pk),
            "publish": True,
        }
        response = self.post_json(reverse("wiki:publish", args=[node.pk]), payload)
        self.assertEqual(response.status_code, 200, response.content)
        node.refresh_from_db()
        content.refresh_from_db()
        self.assertEqual(node.title, "승격 제목")
        self.assertEqual(content.published_blocks, content.blocks)
        self.assertEqual(content.published_properties, {"RPM": 720})
        self.assertEqual(content.draft_meta, {})
        self.assertTrue(PageRevision.objects.filter(page=content, reason="게시").exists())

    def test_stale_autosave_returns_conflict(self):
        node, content = self.make_page()
        response = self.post_json(
            reverse("wiki:autosave", args=[node.pk]),
            {"version": content.version + 1, "title": node.title, "blocks": [], "properties": {}},
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"], "conflict")

    def test_cycle_move_is_rejected(self):
        child = WikiNode.objects.create(
            kind=WikiNode.Kind.FOLDER,
            title="AR",
            parent=self.root,
            status=WikiNode.Status.PUBLISHED,
        )
        response = self.post_json(
            reverse("wiki:node_move", args=[self.root.pk]),
            {"newParentId": str(child.pk)},
        )
        self.assertEqual(response.status_code, 400)
        self.root.refresh_from_db()
        self.assertIsNone(self.root.parent_id)

    def test_soft_delete_and_restore(self):
        node, _ = self.make_page()
        delete_response = self.client.post(reverse("wiki:node_delete", args=[node.pk]), HTTP_ACCEPT="application/json")
        self.assertEqual(delete_response.status_code, 200)
        node.refresh_from_db()
        self.assertTrue(node.is_deleted)
        restore_response = self.client.post(reverse("wiki:node_restore", args=[node.pk]), HTTP_ACCEPT="application/json")
        self.assertEqual(restore_response.status_code, 200)
        node.refresh_from_db()
        self.assertFalse(node.is_deleted)

    def test_image_upload_reencodes_file_and_rejects_active_formats(self):
        source = io.BytesIO()
        Image.new("RGB", (16, 12), "#5633aa").save(source, format="JPEG", exif=b"Exif\x00\x00")
        upload = SimpleUploadedFile("../../weapon.jpg", source.getvalue(), content_type="image/jpeg")
        response = self.client.post(reverse("wiki:asset_upload"), {"image": upload, "alt_text": "무기"})
        self.assertEqual(response.status_code, 201, response.content)
        asset = Asset.objects.get(pk=response.json()["asset"]["id"])
        self.assertNotIn("..", asset.original_name)
        with Image.open(asset.file.path) as stored:
            self.assertEqual(stored.size, (16, 12))
            self.assertFalse(stored.getexif())


class EmbedServiceTests(TestCase):
    def test_youtube_and_sheet_urls_are_canonicalized(self):
        youtube = canonicalize_youtube_url("https://www.youtube.com/shorts/dQw4w9WgXcQ?t=8")
        self.assertEqual(youtube["videoId"], "dQw4w9WgXcQ")
        self.assertIn("youtube-nocookie.com/embed/dQw4w9WgXcQ", youtube["embedUrl"])

        sheet = canonicalize_google_sheet(
            "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz1234567890/edit#gid=7",
            cell_range="B2:F12",
        )
        self.assertEqual(sheet["range"], "B2:F12")
        self.assertIn("docs.google.com/spreadsheets/d/", sheet["embedUrl"])

    def test_direct_cycle_guard_raises_validation_error(self):
        root = WikiNode.objects.create(kind=WikiNode.Kind.FOLDER, title="Root")
        child = WikiNode.objects.create(kind=WikiNode.Kind.FOLDER, title="Child", parent=root)
        with self.assertRaisesMessage(Exception, "하위"):
            move_node(root, new_parent=child)
