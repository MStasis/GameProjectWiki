from django import forms
from django.contrib.auth.forms import AuthenticationForm
from django.core.exceptions import ValidationError

from .models import Tag, WikiNode
from .services import descendant_ids


class StaffAuthenticationForm(AuthenticationForm):
    def confirm_login_allowed(self, user):
        super().confirm_login_allowed(user)
        if not user.is_staff:
            raise ValidationError("편집 권한이 있는 계정만 로그인할 수 있습니다.", code="not_staff")


class SearchForm(forms.Form):
    q = forms.CharField(required=False, max_length=100, label="검색")


class WikiNodeForm(forms.ModelForm):
    tags = forms.ModelMultipleChoiceField(
        queryset=Tag.objects.all(),
        required=False,
        label="태그",
    )

    class Meta:
        model = WikiNode
        fields = ("title", "slug", "summary", "kind", "parent", "status", "tags")
        labels = {
            "title": "제목",
            "slug": "주소 이름",
            "summary": "요약",
            "kind": "종류",
            "parent": "상위 폴더",
            "status": "상태",
        }
        widgets = {
            "summary": forms.Textarea(attrs={"rows": 3}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        parent_queryset = WikiNode.objects.alive().filter(kind=WikiNode.Kind.FOLDER)
        if self.instance and self.instance.pk:
            excluded = descendant_ids(self.instance, include_self=True)
            parent_queryset = parent_queryset.exclude(pk__in=excluded)
            self.fields["kind"].disabled = True
        self.fields["parent"].queryset = parent_queryset.order_by("title")
        self.fields["parent"].required = False
        self.fields["slug"].required = False

    def clean(self):
        cleaned = super().clean()
        parent = cleaned.get("parent")
        if parent and parent.kind != WikiNode.Kind.FOLDER:
            self.add_error("parent", "폴더만 상위 항목으로 선택할 수 있습니다.")
        if parent and self.instance.pk and parent.pk in descendant_ids(self.instance, include_self=True):
            self.add_error("parent", "자기 자신이나 하위 항목을 상위 폴더로 지정할 수 없습니다.")
        return cleaned


class PageEditorForm(forms.Form):
    title = forms.CharField(max_length=180)
    summary = forms.CharField(required=False, max_length=500, widget=forms.Textarea)
    parent = forms.ModelChoiceField(
        queryset=WikiNode.objects.none(),
        required=False,
    )
    template = forms.CharField(required=False, max_length=50)
    tags = forms.CharField(required=False, max_length=1000)

    def __init__(self, *args, node=None, **kwargs):
        self.node = node
        super().__init__(*args, **kwargs)
        queryset = WikiNode.objects.alive().filter(kind=WikiNode.Kind.FOLDER)
        if node and node.pk:
            queryset = queryset.exclude(pk__in=descendant_ids(node, include_self=True))
        self.fields["parent"].queryset = queryset.order_by("title")


class AssetUploadForm(forms.Form):
    image = forms.ImageField(required=False)
    file = forms.ImageField(required=False)
    node_id = forms.UUIDField(required=False)
    alt_text = forms.CharField(required=False, max_length=240)
    caption = forms.CharField(required=False, max_length=500)

    def clean(self):
        cleaned = super().clean()
        upload = cleaned.get("image") or cleaned.get("file")
        if not upload:
            raise ValidationError("업로드할 이미지를 선택해 주세요.")
        cleaned["upload"] = upload
        node_id = cleaned.get("node_id")
        if node_id:
            try:
                cleaned["node"] = WikiNode.objects.alive().get(pk=node_id, kind=WikiNode.Kind.PAGE)
            except WikiNode.DoesNotExist as exc:
                raise ValidationError("이미지를 연결할 페이지를 찾을 수 없습니다.") from exc
        else:
            cleaned["node"] = None
        return cleaned
