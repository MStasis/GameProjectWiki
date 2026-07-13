from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from wiki.models import PageContent, Tag, WikiNode
from wiki.services import build_search_text, normalize_blocks


class Command(BaseCommand):
    help = "로컬 화면 확인용 SF 루트슈터 데모 문서를 생성합니다."

    def add_arguments(self, parser):
        parser.add_argument("--username", default="operator")
        parser.add_argument("--password", default=None)

    @transaction.atomic
    def handle(self, *args, **options):
        user = None
        if options["password"]:
            user, _ = get_user_model().objects.get_or_create(
                username=options["username"],
                defaults={"is_staff": True, "is_superuser": True},
            )
            user.is_staff = True
            user.is_superuser = True
            user.set_password(options["password"])
            user.save()

        overview = self.folder("게임 개요", "프로젝트의 핵심 방향과 최신 설계 상태", 0, user=user)
        anomalies = self.folder("이상 현상", "관측 규칙을 벗어난 사건과 개체 기록", 1, user=user)
        weapons = self.folder("무기", "아스널, 제조 세력과 전투 밸런스", 2, user=user)
        combat = self.folder("전투 시스템", "피해, 상태 효과와 전투 흐름", 3, user=user)
        ar = self.folder("AR", "중거리 교전을 위한 돌격소총", 0, parent=weapons, user=user)

        self.page(
            "프로젝트 지향점",
            overview,
            "스페이스 오페라와 이상 현상이 교차하는 SF 루트슈터",
            "system",
            {"장르": "SF 루트슈터", "상태": "프리 프로덕션", "플랫폼": "PC"},
            [
                {
                    "id": "intro",
                    "type": "text",
                    "data": {
                        "html": "<h2>미지의 항로, 수집되는 진실</h2><p>플레이어는 붕괴한 성계의 전리품을 회수하며 현실 법칙을 침식하는 현상을 추적합니다.</p>"
                    },
                },
                {
                    "id": "pillars",
                    "type": "callout",
                    "data": {
                        "tone": "info",
                        "title": "핵심 경험",
                        "html": "<p>강력한 총기 조작감 · 의미 있는 전리품 · 규칙을 학습해야 하는 이상 현상</p>",
                    },
                },
            ],
            ["핵심", "방향성"],
            user,
        )
        self.page(
            "거울꽃 군집",
            anomalies,
            "관측자의 장비 구성을 복제하는 광학성 이상 현상",
            "anomaly",
            {"위험 등급": "III", "상태": "관측 중", "최초 발견": "칼리스토 잔해 지대"},
            [
                {
                    "id": "warning",
                    "type": "callout",
                    "data": {
                        "tone": "warning",
                        "title": "접촉 절차",
                        "html": "<p>동일한 장비를 착용한 대원이 동시에 군집에 접근해서는 안 됩니다.</p>",
                    },
                },
                {
                    "id": "rule",
                    "type": "text",
                    "data": {
                        "html": "<h2>작동 규칙</h2><p>거울꽃은 가장 가까운 관측자의 무기 특성을 기록한 뒤 적대 개체에 왜곡된 형태로 투영합니다.</p>"
                    },
                },
            ],
            ["이상 현상", "전투 기믹"],
            user,
        )
        self.page(
            "VX-9 특이점 카빈",
            ar,
            "짧은 중력 펄스로 탄착군을 압축하는 고급 돌격소총",
            "weapon",
            {"희귀도": "EXOTIC", "RPM": 720, "탄창": 36, "제조 세력": "오르페우스 조선소"},
            [
                {
                    "id": "weapon-intro",
                    "type": "text",
                    "data": {
                        "html": "<h2>무기 개요</h2><p>연속 명중 시 다음 탄의 산포가 감소하며, 최대 중첩에서 재장전하면 주변 적에게 중력 파동을 방출합니다.</p>"
                    },
                },
                {
                    "id": "balance",
                    "type": "callout",
                    "data": {
                        "tone": "note",
                        "title": "밸런스 메모",
                        "html": "<p>보스 대상 중력 파동 피해는 일반 적의 35%로 제한합니다.</p>",
                    },
                },
            ],
            ["AR", "특이 무기", "검토 중"],
            user,
        )
        self.page(
            "상태 효과 규칙",
            combat,
            "속성 축적과 발동 우선순위 정의",
            "system",
            {"설계 버전": "0.3", "상태": "검토 중"},
            [
                {
                    "id": "status",
                    "type": "text",
                    "data": {
                        "html": "<h2>기본 원칙</h2><p>각 속성은 축적 수치가 임계점에 도달하면 고유 반응을 일으키며, 동일 프레임에서는 이상 현상 반응이 일반 속성보다 먼저 처리됩니다.</p>"
                    },
                }
            ],
            ["전투", "상태 효과"],
            user,
        )
        self.stdout.write(self.style.SUCCESS("데모 위키 데이터를 생성했습니다."))

    def folder(self, title, summary, position, *, parent=None, user=None):
        node, _ = WikiNode.objects.get_or_create(
            title=title,
            parent=parent,
            defaults={
                "kind": WikiNode.Kind.FOLDER,
                "summary": summary,
                "position": position,
                "status": WikiNode.Status.PUBLISHED,
                "created_by": user,
                "updated_by": user,
            },
        )
        return node

    def page(self, title, parent, summary, template, properties, blocks, tags, user):
        node, _ = WikiNode.objects.get_or_create(
            title=title,
            parent=parent,
            defaults={
                "kind": WikiNode.Kind.PAGE,
                "summary": summary,
                "position": parent.children.count(),
                "status": WikiNode.Status.PUBLISHED,
                "created_by": user,
                "updated_by": user,
            },
        )
        normalized = normalize_blocks(blocks)
        node.tags.set([Tag.objects.get_or_create(name=name)[0] for name in tags])
        content, _ = PageContent.objects.get_or_create(node=node)
        content.blocks = normalized
        content.properties = properties
        content.template = template
        content.published_blocks = normalized
        content.published_properties = properties
        content.published_template = template
        content.search_text = build_search_text(node, normalized, properties)
        content.published_search_text = content.search_text
        content.save()
        return node
