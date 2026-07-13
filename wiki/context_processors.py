def wiki_navigation(request):
    from django.conf import settings

    from .models import WikiNode

    queryset = WikiNode.objects.filter(is_deleted=False).order_by("position", "title")
    if not (request.user.is_authenticated and request.user.is_staff):
        queryset = queryset.filter(status=WikiNode.Status.PUBLISHED)

    nodes = list(queryset)
    node_map = {node.pk: node for node in nodes}
    for node in nodes:
        node.nav_children = []
    roots = []
    for node in nodes:
        if node.parent_id is None:
            roots.append(node)
        elif node.parent_id in node_map:
            node_map[node.parent_id].nav_children.append(node)
    return {
        "navigation_roots": roots,
        "site_title": settings.SITE_TITLE,
    }
