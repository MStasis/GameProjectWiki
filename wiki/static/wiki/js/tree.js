(function () {
  "use strict";

  function ready(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  function readJsonScript(ids, fallback) {
    for (var index = 0; index < ids.length; index += 1) {
      var script = document.getElementById(ids[index]);
      if (!script) {
        continue;
      }
      try {
        return JSON.parse(script.textContent || "null") ?? fallback;
      } catch (error) {
        console.error("트리 설정 JSON을 읽지 못했습니다.", error);
        return fallback;
      }
    }
    return fallback;
  }

  function getCookie(name) {
    var prefix = name + "=";
    var cookies = document.cookie ? document.cookie.split(";") : [];
    for (var index = 0; index < cookies.length; index += 1) {
      var cookie = cookies[index].trim();
      if (cookie.indexOf(prefix) === 0) {
        return decodeURIComponent(cookie.slice(prefix.length));
      }
    }
    return "";
  }

  ready(function () {
    var wrapper = document.getElementById("structure-tree");
    var tree = document.getElementById("tree-editor") || wrapper;
    if (!tree) {
      return;
    }

    var config = readJsonScript(
      ["tree-config-data", "tree-config", "editor-config-data", "editor-config"],
      {}
    );
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      config = {};
    }
    var status =
      document.getElementById("tree-save-status") ||
      document.querySelector("[data-tree-status]");
    var csrfToken =
      config.csrfToken ||
      tree.dataset.csrfToken ||
      ((wrapper || tree).querySelector('[name="csrfmiddlewaretoken"]') || {}).value ||
      getCookie("csrftoken") ||
      "";
    var moving = false;
    var draggedNode = null;
    var dropTarget = null;
    var dropPosition = "";

    function setStatus(message, state) {
      tree.dataset.state = state || "idle";
      if (!status) {
        return;
      }
      status.textContent = message;
      status.dataset.state = state || "idle";
      status.setAttribute("aria-live", state === "error" ? "assertive" : "polite");
    }

    function directNodeChildren(container) {
      if (!container) {
        return [];
      }
      return Array.from(container.children).filter(function (child) {
        return child.matches("li[data-node-id]");
      });
    }

    function childContainer(node, create) {
      var children = Array.from(node.children).find(function (child) {
        return child.matches("ul, ol, [data-tree-children]");
      });
      if (!children && create) {
        children = document.createElement("ul");
        children.className = "tree-children";
        children.dataset.treeChildren = "";
        node.appendChild(children);
      }
      return children || null;
    }

    function topContainer() {
      if (tree.matches("ul, ol, [data-tree-children]")) {
        return tree;
      }
      return (
        Array.from(tree.children).find(function (child) {
          return child.matches("ul, ol, [data-tree-children]");
        }) || tree
      );
    }

    function updateDepths() {
      function visit(container, depth) {
        directNodeChildren(container).forEach(function (node) {
          node.dataset.nodeDepth = String(depth);
          visit(childContainer(node, false), depth + 1);
        });
      }
      visit(topContainer(), 0);
    }

    function parentNode(node) {
      if (!node || !node.parentElement) {
        return null;
      }
      return node.parentElement.closest("li[data-node-id]");
    }

    function ownElements(node, selector) {
      return Array.from(node.querySelectorAll(selector)).filter(function (element) {
        return element.closest("li[data-node-id]") === node;
      });
    }

    function canAcceptChildren(node) {
      if (!node) {
        return false;
      }
      if (node.dataset.nodeKind) {
        return node.dataset.nodeKind === "folder";
      }
      var row = Array.from(node.children).find(function (child) {
        return !child.matches("ul, ol, [data-tree-children]");
      });
      return !row || !row.classList.contains("structure-node--page");
    }

    function previousNode(node) {
      var sibling = node ? node.previousElementSibling : null;
      while (sibling && !sibling.matches("li[data-node-id]")) {
        sibling = sibling.previousElementSibling;
      }
      return sibling;
    }

    function nextNode(node) {
      var sibling = node ? node.nextElementSibling : null;
      while (sibling && !sibling.matches("li[data-node-id]")) {
        sibling = sibling.nextElementSibling;
      }
      return sibling;
    }

    function cleanEmptyContainer(container) {
      if (
        container &&
        container !== topContainer() &&
        directNodeChildren(container).length === 0
      ) {
        container.remove();
      }
    }

    function updateControls() {
      updateDepths();
      var nodes = Array.from(tree.querySelectorAll("li[data-node-id]"));
      nodes.forEach(function (node) {
        var previous = previousNode(node);
        var next = nextNode(node);
        var parent = parentNode(node);
        var children = childContainer(node, false);
        var childNodes = directNodeChildren(children);

        ownElements(node, "[data-tree-action]").forEach(function (button) {
          var action = button.dataset.treeAction;
          if (action === "up") {
            button.disabled = moving || !previous;
          } else if (action === "down") {
            button.disabled = moving || !next;
          } else if (action === "indent") {
            button.disabled = moving || !previous || !canAcceptChildren(previous);
          } else if (action === "outdent") {
            button.disabled = moving || !parent;
          }
        });

        var handle = ownElements(node, "[data-tree-handle]")[0];
        if (handle) {
          handle.draggable = !moving;
          handle.setAttribute("aria-grabbed", "false");
        }

        var toggle = ownElements(node, "[data-tree-toggle]")[0];
        if (toggle) {
          toggle.disabled = childNodes.length === 0;
          toggle.setAttribute(
            "aria-expanded",
            childNodes.length && children && !children.hidden ? "true" : "false"
          );
        }

        var siblings = directNodeChildren(node.parentElement);
        node.setAttribute("aria-posinset", String(siblings.indexOf(node) + 1));
        node.setAttribute("aria-setsize", String(siblings.length));
      });
    }

    function clearDropIndicators() {
      tree.classList.remove("is-drop-at-end");
      tree.querySelectorAll(
        ".is-drop-before, .is-drop-inside, .is-drop-after"
      ).forEach(function (node) {
        node.classList.remove("is-drop-before", "is-drop-inside", "is-drop-after");
      });
      dropTarget = null;
      dropPosition = "";
    }

    function reloadAfterError(message) {
      setStatus((message || "순서를 변경하지 못했습니다.") + " 다시 불러옵니다.", "error");
      window.setTimeout(function () {
        window.location.reload();
      }, 250);
    }

    function moveEndpoint(node) {
      return (
        node.dataset.moveUrl ||
        config.moveTreeUrl ||
        tree.dataset.moveUrl ||
        (wrapper && wrapper.dataset.moveUrl) ||
        ""
      );
    }

    async function requestMove(node, payload, applyDomMove) {
      if (moving) {
        return;
      }
      var endpoint = moveEndpoint(node);
      if (!endpoint) {
        reloadAfterError("트리 이동 주소가 설정되지 않았습니다.");
        return;
      }

      moving = true;
      tree.setAttribute("aria-busy", "true");
      updateControls();
      setStatus("구조 저장 중…", "saving");

      try {
        var headers = {
          Accept: "application/json",
          "Content-Type": "application/json",
        };
        if (csrfToken) {
          headers["X-CSRFToken"] = csrfToken;
        }
        var response = await fetch(endpoint, {
          method: config.moveMethod || "POST",
          credentials: "same-origin",
          headers: headers,
          body: JSON.stringify(payload),
        });
        var result = await response.json().catch(function () {
          return {};
        });
        if (!response.ok || result.ok === false) {
          throw new Error(result.error || result.message || "구조를 변경하지 못했습니다.");
        }
        applyDomMove();
        setStatus("구조가 저장되었습니다.", "saved");
      } catch (error) {
        reloadAfterError(error.message);
        return;
      } finally {
        moving = false;
        tree.removeAttribute("aria-busy");
        clearDropIndicators();
        updateControls();
      }
    }

    function commonPayload(node, parent, before, after) {
      return {
        nodeId: node.dataset.nodeId,
        newParentId: parent ? parent.dataset.nodeId : null,
        beforeId: before ? before.dataset.nodeId : null,
        afterId: after ? after.dataset.nodeId : null,
      };
    }

    function moveUp(node) {
      var previous = previousNode(node);
      if (!previous) {
        return;
      }
      var oldContainer = node.parentElement;
      requestMove(
        node,
        commonPayload(node, parentNode(node), previous, null),
        function () {
          oldContainer.insertBefore(node, previous);
        }
      );
    }

    function moveDown(node) {
      var next = nextNode(node);
      if (!next) {
        return;
      }
      var oldContainer = node.parentElement;
      requestMove(
        node,
        commonPayload(node, parentNode(node), null, next),
        function () {
          oldContainer.insertBefore(node, next.nextElementSibling);
        }
      );
    }

    function indentNode(node) {
      var previous = previousNode(node);
      if (!previous || !canAcceptChildren(previous)) {
        return;
      }
      var oldContainer = node.parentElement;
      var existingChildren = childContainer(previous, false);
      var existingNodes = directNodeChildren(existingChildren);
      var after = existingNodes.length ? existingNodes[existingNodes.length - 1] : null;
      requestMove(node, commonPayload(node, previous, null, after), function () {
        childContainer(previous, true).appendChild(node);
        cleanEmptyContainer(oldContainer);
      });
    }

    function outdentNode(node) {
      var parent = parentNode(node);
      if (!parent) {
        return;
      }
      var oldContainer = node.parentElement;
      var grandParent = parentNode(parent);
      var destination = parent.parentElement;
      requestMove(node, commonPayload(node, grandParent, null, parent), function () {
        destination.insertBefore(node, parent.nextElementSibling);
        cleanEmptyContainer(oldContainer);
      });
    }

    function positionForPointer(node, clientY) {
      var row = node.querySelector(":scope > [data-tree-row]");
      if (!row) {
        row = Array.from(node.children).find(function (child) {
          return !child.matches("ul, ol, [data-tree-children]");
        });
      }
      var rectangle = (row || node).getBoundingClientRect();
      if (!rectangle.height) {
        return "inside";
      }
      var ratio = (clientY - rectangle.top) / rectangle.height;
      if (ratio < 0.3) {
        return "before";
      }
      if (ratio > 0.7) {
        return "after";
      }
      if (!canAcceptChildren(node)) {
        return ratio < 0.5 ? "before" : "after";
      }
      return "inside";
    }

    function performDrop(node, target, position) {
      var oldContainer = node.parentElement;
      if (position === "inside") {
        if (!canAcceptChildren(target)) {
          return;
        }
        var children = childContainer(target, false);
        var existing = directNodeChildren(children).filter(function (child) {
          return child !== node;
        });
        var after = existing.length ? existing[existing.length - 1] : null;
        requestMove(node, commonPayload(node, target, null, after), function () {
          childContainer(target, true).appendChild(node);
          cleanEmptyContainer(oldContainer);
        });
        return;
      }

      var targetParent = parentNode(target);
      if (position === "before") {
        requestMove(node, commonPayload(node, targetParent, target, null), function () {
          target.parentElement.insertBefore(node, target);
          cleanEmptyContainer(oldContainer);
        });
      } else {
        requestMove(node, commonPayload(node, targetParent, null, target), function () {
          target.parentElement.insertBefore(node, target.nextElementSibling);
          cleanEmptyContainer(oldContainer);
        });
      }
    }

    tree.addEventListener("click", function (event) {
      var toggle = event.target.closest("[data-tree-toggle]");
      if (toggle) {
        var toggleNode = toggle.closest("li[data-node-id]");
        var children = toggleNode ? childContainer(toggleNode, false) : null;
        if (children && directNodeChildren(children).length) {
          children.hidden = !children.hidden;
          toggleNode.classList.toggle("is-collapsed", children.hidden);
          toggle.setAttribute("aria-expanded", children.hidden ? "false" : "true");
        }
        return;
      }

      var actionButton = event.target.closest("[data-tree-action]");
      if (!actionButton || actionButton.disabled || moving) {
        return;
      }
      var node = actionButton.closest("li[data-node-id]");
      if (!node) {
        return;
      }
      var action = actionButton.dataset.treeAction;
      if (action === "up") {
        moveUp(node);
      } else if (action === "down") {
        moveDown(node);
      } else if (action === "indent") {
        indentNode(node);
      } else if (action === "outdent") {
        outdentNode(node);
      }
    });

    tree.addEventListener("dragstart", function (event) {
      var handle = event.target.closest("[data-tree-handle]");
      if (!handle || moving) {
        event.preventDefault();
        return;
      }
      draggedNode = handle.closest("li[data-node-id]");
      if (!draggedNode) {
        event.preventDefault();
        return;
      }
      draggedNode.classList.add("is-dragging");
      draggedNode.setAttribute("aria-grabbed", "true");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedNode.dataset.nodeId);
    });

    tree.addEventListener("dragover", function (event) {
      if (!draggedNode || moving) {
        return;
      }
      var target = event.target.closest("li[data-node-id]");
      if (target && (target === draggedNode || draggedNode.contains(target))) {
        clearDropIndicators();
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearDropIndicators();
      if (!target) {
        tree.classList.add("is-drop-at-end");
        dropPosition = "root-end";
        return;
      }
      dropTarget = target;
      dropPosition = positionForPointer(target, event.clientY);
      target.classList.add("is-drop-" + dropPosition);
    });

    tree.addEventListener("drop", function (event) {
      if (!draggedNode || moving) {
        return;
      }
      event.preventDefault();
      var node = draggedNode;
      var target = dropTarget;
      var position = dropPosition;
      clearDropIndicators();

      if (position === "root-end") {
        var destination = topContainer();
        var roots = directNodeChildren(destination).filter(function (root) {
          return root !== node;
        });
        var after = roots.length ? roots[roots.length - 1] : null;
        var oldContainer = node.parentElement;
        requestMove(node, commonPayload(node, null, null, after), function () {
          destination.appendChild(node);
          cleanEmptyContainer(oldContainer);
        });
      } else if (target && !node.contains(target)) {
        performDrop(node, target, position);
      }
    });

    tree.addEventListener("dragend", function () {
      if (draggedNode) {
        draggedNode.classList.remove("is-dragging");
        draggedNode.setAttribute("aria-grabbed", "false");
      }
      draggedNode = null;
      clearDropIndicators();
    });

    updateControls();
    setStatus("구조 편집 준비됨", "idle");
  });
})();
