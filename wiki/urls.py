from django.contrib.auth.views import LogoutView
from django.urls import path

from . import views


app_name = "wiki"

urlpatterns = [
    path("", views.home, name="home"),
    path("search/", views.search, name="search"),
    path("n/<uuid:node_id>/<str:slug>/", views.node_detail, name="node_detail"),
    path("login/", views.StaffLoginView.as_view(), name="login"),
    path("logout/", LogoutView.as_view(), name="logout"),
    path("dashboard/", views.dashboard, name="dashboard"),
    path("manage/editor/", views.editor, name="editor"),
    path("manage/structure/", views.structure, name="structure"),
    path("manage/trash/", views.trash, name="trash"),
    path("manage/nodes/new/", views.node_create, name="node_create"),
    path("manage/nodes/<uuid:node_id>/edit/", views.node_edit, name="node_edit"),
    path("manage/nodes/<uuid:node_id>/revisions/", views.revisions, name="revisions"),
    path("manage/nodes/<uuid:node_id>/autosave/", views.autosave, name="autosave"),
    path("manage/nodes/<uuid:node_id>/publish/", views.publish, name="publish"),
    path("manage/nodes/<uuid:node_id>/unpublish/", views.unpublish, name="unpublish"),
    path("manage/nodes/<uuid:node_id>/move/", views.node_move, name="node_move"),
    path("manage/nodes/<uuid:node_id>/delete/", views.node_delete, name="node_delete"),
    path("manage/nodes/<uuid:node_id>/restore/", views.node_restore, name="node_restore"),
    path("manage/nodes/<uuid:node_id>/purge/", views.node_purge, name="node_purge"),
    path(
        "manage/nodes/<uuid:node_id>/revisions/<uuid:revision_id>/restore/",
        views.revision_restore,
        name="revision_restore",
    ),
    path("manage/assets/upload/", views.asset_upload, name="asset_upload"),
]
