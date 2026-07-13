(function () {
  "use strict";

  var AUTOSAVE_DELAY = 3000;
  var BLOCK_LABELS = {
    text: "텍스트",
    image: "이미지",
    youtube: "YouTube",
    sheet: "Google 스프레드시트",
    callout: "강조 상자",
    divider: "구분선",
  };
  var TYPE_ALIASES = {
    rich_text: "text",
    google_sheet: "sheet",
  };

  function ready(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  function createElement(tagName, className, text) {
    var element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    if (text !== undefined && text !== null) {
      element.textContent = text;
    }
    return element;
  }

  function createButton(label, className) {
    var button = createElement("button", className, label);
    button.type = "button";
    return button;
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
        console.error("편집기 JSON을 읽을 수 없습니다.", error);
        return fallback;
      }
    }
    return fallback;
  }

  function generateBlockId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      var bytes = new Uint8Array(12);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, function (byte) {
        return byte.toString(16).padStart(2, "0");
      }).join("");
    }
    return String(Date.now()) + "-" + Math.random().toString(36).slice(2);
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

  function normalizedType(type) {
    var value = String(type || "text").toLowerCase();
    return TYPE_ALIASES[value] || value;
  }

  function normalizeBlock(rawBlock) {
    var raw = rawBlock && typeof rawBlock === "object" ? rawBlock : {};
    var data = raw.data && typeof raw.data === "object" ? raw.data : raw;
    var block = {
      id: String(raw.id || data.id || generateBlockId()),
      type: normalizedType(raw.type || data.type),
    };

    if (!Object.prototype.hasOwnProperty.call(BLOCK_LABELS, block.type)) {
      block.type = "text";
    }

    if (block.type === "text") {
      block.html = String(data.html || "");
    } else if (block.type === "image") {
      block.asset_id = data.asset_id ?? data.assetId ?? "";
      block.url = String(data.url || "");
      block.alt = String(data.alt ?? data.altText ?? "");
      block.caption = String(data.caption || "");
    } else if (block.type === "youtube") {
      block.url = String(data.url || "");
    } else if (block.type === "sheet") {
      block.url = String(data.url || "");
      block.range = String(data.range || "");
      block.height = Number(data.height) || 480;
    } else if (block.type === "callout") {
      block.tone = ["info", "note", "success", "warning", "danger"].includes(
        data.tone
      )
        ? data.tone
        : "info";
      block.title = String(data.title || "");
      block.html = String(data.html || "");
    }

    return block;
  }

  function safeLink(value) {
    var raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    if (raw.charAt(0) === "#" || raw.charAt(0) === "/") {
      return raw;
    }
    try {
      var parsed = new URL(raw, window.location.href);
      if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
        return parsed.href;
      }
    } catch (error) {
      return "";
    }
    return "";
  }

  function safeMediaUrl(value) {
    var raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    if (raw.charAt(0) === "/") {
      return raw;
    }
    try {
      var parsed = new URL(raw, window.location.href);
      if (["http:", "https:", "blob:"].includes(parsed.protocol)) {
        return parsed.href;
      }
    } catch (error) {
      return "";
    }
    return "";
  }

  function sanitizeStyle(styleText) {
    var source = document.createElement("span");
    source.setAttribute("style", String(styleText || ""));
    var result = [];
    var allowed = [
      "color",
      "background-color",
      "text-align",
      "font-family",
      "font-size",
    ];

    allowed.forEach(function (property) {
      var value = source.style.getPropertyValue(property).trim();
      if (!value || /url\s*\(|expression\s*\(|[<>]/i.test(value)) {
        return;
      }
      if (
        property === "text-align" &&
        !["left", "center", "right", "justify"].includes(value)
      ) {
        return;
      }
      if (property === "font-family" && /[;{}]/.test(value)) {
        return;
      }
      if (
        property === "font-size" &&
        !/^(?:[1-9]\d?(?:\.\d+)?(?:px|rem|em|%)|x?-?small|medium|large|x-large)$/i.test(
          value
        )
      ) {
        return;
      }
      if (window.CSS && typeof window.CSS.supports === "function") {
        if (!window.CSS.supports(property, value)) {
          return;
        }
      }
      result.push(property + ": " + value);
    });

    return result.join("; ");
  }

  function sanitizeRichHtml(html) {
    var template = document.createElement("template");
    template.innerHTML = String(html || "");
    var output = document.createElement("div");
    var allowedTags = new Set([
      "A",
      "B",
      "BLOCKQUOTE",
      "BR",
      "DIV",
      "EM",
      "FONT",
      "H2",
      "H3",
      "H4",
      "I",
      "LI",
      "OL",
      "P",
      "S",
      "SPAN",
      "STRONG",
      "U",
      "UL",
    ]);
    var blockedTags = new Set([
      "APPLET",
      "BUTTON",
      "EMBED",
      "FORM",
      "IFRAME",
      "INPUT",
      "MATH",
      "OBJECT",
      "SCRIPT",
      "SELECT",
      "STYLE",
      "SVG",
      "TEMPLATE",
      "TEXTAREA",
    ]);

    function appendClean(node, parent) {
      if (node.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(node.nodeValue || ""));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      var tagName = node.tagName.toUpperCase();
      if (blockedTags.has(tagName)) {
        return;
      }

      if (!allowedTags.has(tagName)) {
        Array.from(node.childNodes).forEach(function (child) {
          appendClean(child, parent);
        });
        return;
      }

      var outputTag = tagName === "FONT" ? "span" : tagName === "DIV" ? "p" : tagName.toLowerCase();
      var clean = document.createElement(outputTag);
      var styleParts = [];
      var style = sanitizeStyle(node.getAttribute("style"));
      if (style) {
        styleParts.push(style);
      }

      if (tagName === "A") {
        var href = safeLink(node.getAttribute("href"));
        if (href) {
          clean.setAttribute("href", href);
          if (!href.startsWith("#") && !href.startsWith("/")) {
            clean.setAttribute("target", "_blank");
            clean.setAttribute("rel", "noopener noreferrer");
          }
        }
        var title = String(node.getAttribute("title") || "").slice(0, 300);
        if (title) {
          clean.setAttribute("title", title);
        }
      } else if (tagName === "FONT") {
        var color = String(node.getAttribute("color") || "");
        var size = String(node.getAttribute("size") || "");
        var face = String(node.getAttribute("face") || "");
        if (/^(?:#[0-9a-f]{3,8}|[a-z]{1,24})$/i.test(color)) {
          styleParts.push("color: " + color);
        }
        if (/^[1-7]$/.test(size)) {
          var fontSizes = {
            1: "10px",
            2: "13px",
            3: "16px",
            4: "18px",
            5: "24px",
            6: "32px",
            7: "48px",
          };
          styleParts.push("font-size: " + fontSizes[size]);
        }
        if (face && face.length <= 80 && !/[;{}<>]/.test(face)) {
          styleParts.push("font-family: " + face);
        }
      }

      if (styleParts.length) {
        clean.setAttribute("style", styleParts.join("; "));
      }

      Array.from(node.childNodes).forEach(function (child) {
        appendClean(child, clean);
      });
      parent.appendChild(clean);
    }

    Array.from(template.content.childNodes).forEach(function (node) {
      appendClean(node, output);
    });
    return output.innerHTML;
  }

  function youtubeVideoId(value) {
    var raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    if (!raw.includes("://")) {
      raw = "https://" + raw;
    }
    try {
      var parsed = new URL(raw);
      var host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      var id = "";
      if (host === "youtu.be") {
        id = parsed.pathname.split("/").filter(Boolean)[0] || "";
      } else if (
        host === "youtube.com" ||
        host === "m.youtube.com" ||
        host === "youtube-nocookie.com"
      ) {
        if (parsed.pathname === "/watch") {
          id = parsed.searchParams.get("v") || "";
        } else {
          var parts = parsed.pathname.split("/").filter(Boolean);
          if (["embed", "shorts", "live"].includes(parts[0])) {
            id = parts[1] || "";
          }
        }
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
    } catch (error) {
      return "";
    }
  }

  function googleSheetEmbedUrl(value, sheetRange) {
    var raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    if (!raw.includes("://")) {
      raw = "https://" + raw;
    }
    try {
      var parsed = new URL(raw);
      if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com") {
        return "";
      }
      var match = parsed.pathname.match(
        /^\/spreadsheets\/d\/(e\/)?([A-Za-z0-9_-]+)(?:\/|$)/
      );
      if (!match || match[2].length < 20) {
        return "";
      }

      var prefix = match[1] ? "e/" : "";
      var identifier = match[2];
      var embed = new URL(
        "https://docs.google.com/spreadsheets/d/" +
          prefix +
          identifier +
          "/pubhtml"
      );
      var hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
      var gid = parsed.searchParams.get("gid") || hashParams.get("gid") || "";
      if (gid && /^\d+$/.test(gid)) {
        embed.searchParams.set("gid", gid);
        embed.searchParams.set("single", "true");
      }
      var range = String(sheetRange || "").trim();
      if (range) {
        if (range.length > 200 || /[<>\u0000-\u001f]/.test(range)) {
          return "";
        }
        embed.searchParams.set("range", range);
      }
      embed.searchParams.set("widget", "true");
      embed.searchParams.set("headers", "false");
      return embed.href;
    } catch (error) {
      return "";
    }
  }

  function createField(labelText, input) {
    var label = createElement("label", "editor-field");
    var text = createElement("span", "editor-field__label", labelText);
    label.append(text, input);
    return label;
  }

  ready(function () {
    var editor = document.getElementById("page-editor");
    var blockList = document.getElementById("editor-block-list");
    if (!editor || !blockList) {
      return;
    }

    var status = document.getElementById("editor-save-status");
    var titleInput = document.getElementById("page-title");
    var summaryInput = document.getElementById("page-summary");
    var templateInput = document.getElementById("page-template");
    var tagsInput = document.getElementById("page-tags");
    var propertiesInput = document.getElementById("page-properties");
    var parentInput = document.getElementById("page-parent");
    var addPropertyButton = document.querySelector("[data-add-property]");
    var saveDraftButton = document.getElementById("save-draft");
    var publishButton = document.getElementById("publish-page");
    var addBlockButtons = Array.from(document.querySelectorAll("[data-add-block]"));
    var initialPayload = readJsonScript(
      ["initial-blocks-data", "initial-blocks"],
      []
    );
    var config = readJsonScript(
      ["editor-config-data", "editor-config"],
      {}
    );
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      config = {};
    }

    var initialBlocks = Array.isArray(initialPayload)
      ? initialPayload
      : Array.isArray(initialPayload.blocks)
        ? initialPayload.blocks
        : [];
    var version = Number(
      config.version ??
        (initialPayload && initialPayload.version) ??
        editor.dataset.version ??
        0
    );
    var csrfToken =
      config.csrfToken ||
      editor.dataset.csrfToken ||
      (editor.querySelector('[name="csrfmiddlewaretoken"]') || {}).value ||
      getCookie("csrftoken") ||
      "";
    var selectionByEditor = new WeakMap();
    var initialized = false;
    var changeCounter = 0;
    var lastSavedCounter = 0;
    var autosaveTimer = null;
    var saveInFlight = false;
    var queuedIntent = null;
    var conflict = false;
    var draggedBlock = null;
    var dragChanged = false;

    function setStatus(message, state) {
      if (!status) {
        return;
      }
      status.textContent = message;
      status.dataset.state = state || "idle";
      status.setAttribute("aria-live", state === "error" ? "assertive" : "polite");
    }

    function saveUrl(publish) {
      if (publish) {
        return (
          config.publishUrl ||
          config.createUrl ||
          editor.dataset.publishUrl ||
          config.saveUrl ||
          editor.dataset.saveUrl ||
          editor.getAttribute("action") ||
          ""
        );
      }
      return (
        config.draftUrl ||
        config.saveUrl ||
        config.createUrl ||
        editor.dataset.saveUrl ||
        editor.getAttribute("action") ||
        ""
      );
    }

    function updateEmptyState() {
      var emptyState = document.querySelector("[data-editor-empty]");
      if (emptyState) {
        emptyState.hidden = Boolean(blockList.querySelector(".editor-block"));
      }
    }

    function updateBlockButtons() {
      var blocks = Array.from(blockList.querySelectorAll(":scope > .editor-block"));
      blocks.forEach(function (block, index) {
        block.setAttribute("aria-posinset", String(index + 1));
        block.setAttribute("aria-setsize", String(blocks.length));
        var up = block.querySelector('[data-block-action="up"]');
        var down = block.querySelector('[data-block-action="down"]');
        if (up) {
          up.disabled = index === 0;
        }
        if (down) {
          down.disabled = index === blocks.length - 1;
        }
      });
      updateEmptyState();
    }

    function captureSelection(editable) {
      var selection = window.getSelection();
      if (!selection || !selection.rangeCount) {
        return;
      }
      var range = selection.getRangeAt(0);
      if (editable.contains(range.commonAncestorContainer)) {
        selectionByEditor.set(editable, range.cloneRange());
      }
    }

    function restoreSelection(editable) {
      editable.focus({ preventScroll: true });
      var range = selectionByEditor.get(editable);
      if (!range || !document.contains(range.commonAncestorContainer)) {
        return;
      }
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    function markDirty() {
      if (!initialized) {
        return;
      }
      changeCounter += 1;
      editor.dataset.dirty = "true";
      if (!saveInFlight && !conflict) {
        setStatus("저장되지 않은 변경사항", "dirty");
      }
      window.clearTimeout(autosaveTimer);
      if (!conflict && saveUrl(false)) {
        autosaveTimer = window.setTimeout(function () {
          requestSave(false, true);
        }, AUTOSAVE_DELAY);
      }
    }

    function applyFormat(editable, command, value) {
      restoreSelection(editable);
      var successful = false;
      try {
        successful = document.execCommand(command, false, value || null);
        if (!successful && command === "hiliteColor") {
          document.execCommand("backColor", false, value || null);
        }
      } catch (error) {
        console.warn("서식을 적용하지 못했습니다.", error);
      }
      captureSelection(editable);
      markDirty();
    }

    function toolbarSelect(label, options, command, editable) {
      var wrapper = createElement("label", "rich-toolbar__select");
      var labelNode = createElement("span", "sr-only", label);
      var select = document.createElement("select");
      select.setAttribute("aria-label", label);
      options.forEach(function (optionData) {
        var option = document.createElement("option");
        option.value = optionData[0];
        option.textContent = optionData[1];
        select.appendChild(option);
      });
      select.addEventListener("change", function () {
        if (select.value) {
          applyFormat(editable, command, select.value);
        }
        select.selectedIndex = 0;
      });
      wrapper.append(labelNode, select);
      return wrapper;
    }

    function createToolbar(editable) {
      var toolbar = createElement("div", "rich-toolbar");
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", "텍스트 서식");

      toolbar.appendChild(
        toolbarSelect(
          "문단 양식",
          [
            ["", "문단"],
            ["p", "본문"],
            ["h2", "제목 2"],
            ["h3", "제목 3"],
            ["h4", "제목 4"],
            ["blockquote", "인용"],
          ],
          "formatBlock",
          editable
        )
      );

      [
        ["굵게", "bold", "B"],
        ["기울임", "italic", "I"],
        ["밑줄", "underline", "U"],
        ["글머리 기호", "insertUnorderedList", "• 목록"],
        ["번호 목록", "insertOrderedList", "1. 목록"],
        ["왼쪽 정렬", "justifyLeft", "왼쪽"],
        ["가운데 정렬", "justifyCenter", "가운데"],
        ["오른쪽 정렬", "justifyRight", "오른쪽"],
      ].forEach(function (definition) {
        var button = createButton(definition[2], "rich-toolbar__button");
        button.dataset.command = definition[1];
        button.setAttribute("aria-label", definition[0]);
        button.title = definition[0];
        button.addEventListener("mousedown", function (event) {
          event.preventDefault();
        });
        button.addEventListener("click", function () {
          applyFormat(editable, button.dataset.command, "");
        });
        toolbar.appendChild(button);
      });

      toolbar.appendChild(
        toolbarSelect(
          "글꼴",
          [
            ["", "글꼴"],
            ["sans-serif", "고딕"],
            ["Malgun Gothic", "맑은 고딕"],
            ["serif", "명조"],
            ["monospace", "고정폭"],
          ],
          "fontName",
          editable
        )
      );
      toolbar.appendChild(
        toolbarSelect(
          "글자 크기",
          [
            ["", "크기"],
            ["2", "작게"],
            ["3", "보통"],
            ["4", "크게"],
            ["5", "매우 크게"],
          ],
          "fontSize",
          editable
        )
      );

      [
        ["글자색", "foreColor", "#111827"],
        ["배경색", "hiliteColor", "#fff3a3"],
      ].forEach(function (definition) {
        var label = createElement("label", "rich-toolbar__color");
        var text = createElement("span", "rich-toolbar__color-label", definition[0]);
        var color = document.createElement("input");
        color.type = "color";
        color.value = definition[2];
        color.setAttribute("aria-label", definition[0]);
        color.addEventListener("change", function () {
          applyFormat(editable, definition[1], color.value);
        });
        label.append(text, color);
        toolbar.appendChild(label);
      });

      return toolbar;
    }

    function configureRichEditor(editable, html, label) {
      editable.className = "rich-editor";
      editable.contentEditable = "true";
      editable.spellcheck = true;
      editable.setAttribute("role", "textbox");
      editable.setAttribute("aria-multiline", "true");
      editable.setAttribute("aria-label", label);
      editable.dataset.richEditor = "";
      editable.innerHTML = sanitizeRichHtml(html) || "<p><br></p>";
      ["focus", "keyup", "mouseup", "input"].forEach(function (eventName) {
        editable.addEventListener(eventName, function () {
          captureSelection(editable);
        });
      });
      editable.addEventListener("paste", function (event) {
        var clipboard = event.clipboardData;
        var richHtml = clipboard ? clipboard.getData("text/html") : "";
        if (!richHtml) {
          return;
        }
        event.preventDefault();
        restoreSelection(editable);
        document.execCommand("insertHTML", false, sanitizeRichHtml(richHtml));
        captureSelection(editable);
        markDirty();
      });
    }

    function createTextInput(className, value, placeholder) {
      var input = document.createElement("input");
      input.type = "text";
      input.className = className || "";
      input.value = value || "";
      if (placeholder) {
        input.placeholder = placeholder;
      }
      return input;
    }

    function setPreviewMessage(container, message, state) {
      container.replaceChildren();
      if (!message) {
        return;
      }
      var text = createElement("p", "embed-preview__message", message);
      text.dataset.state = state || "info";
      container.appendChild(text);
    }

    function createYoutubePreview(container, value) {
      var raw = String(value || "").trim();
      if (!raw) {
        setPreviewMessage(container, "YouTube 링크를 입력하면 미리보기가 표시됩니다.");
        return;
      }
      var videoId = youtubeVideoId(raw);
      if (!videoId) {
        setPreviewMessage(container, "올바른 YouTube 링크를 입력해 주세요.", "error");
        return;
      }
      var frame = document.createElement("iframe");
      frame.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(videoId);
      frame.title = "YouTube 영상 미리보기";
      frame.loading = "lazy";
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      frame.allow = "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture";
      frame.allowFullscreen = true;
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
      container.replaceChildren(frame);
    }

    function createSheetPreview(container, url, range, height) {
      var raw = String(url || "").trim();
      if (!raw) {
        setPreviewMessage(
          container,
          "웹에 게시된 Google 스프레드시트 링크를 입력하면 미리보기가 표시됩니다."
        );
        return;
      }
      var embedUrl = googleSheetEmbedUrl(raw, range);
      if (!embedUrl) {
        setPreviewMessage(
          container,
          "Google 스프레드시트 링크와 범위를 확인해 주세요.",
          "error"
        );
        return;
      }
      var frame = document.createElement("iframe");
      frame.src = embedUrl;
      frame.title = "Google 스프레드시트 미리보기";
      frame.loading = "lazy";
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      frame.height = String(Math.min(1200, Math.max(240, Number(height) || 480)));
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      container.replaceChildren(frame);
    }

    async function uploadImage(block, file) {
      var uploadUrl =
        config.uploadUrl || editor.dataset.uploadUrl || block.dataset.uploadUrl || "";
      var message = block.querySelector("[data-upload-status]");
      var maxBytes = Number(config.maxUploadBytes || 0);
      if (!uploadUrl) {
        message.textContent = "이미지 업로드 주소가 설정되지 않았습니다.";
        message.dataset.state = "error";
        return;
      }
      if (maxBytes && file.size > maxBytes) {
        message.textContent =
          "파일이 너무 큽니다. 최대 " + Math.floor(maxBytes / 1024 / 1024) + "MB입니다.";
        message.dataset.state = "error";
        return;
      }
      if (!/^image\/(?:jpeg|png|webp)$/i.test(file.type)) {
        message.textContent = "JPEG, PNG 또는 WebP 이미지만 업로드할 수 있습니다.";
        message.dataset.state = "error";
        return;
      }

      var preview = block.querySelector("[data-image-preview]");
      var objectUrl = URL.createObjectURL(file);
      preview.src = objectUrl;
      preview.hidden = false;
      message.textContent = "업로드 중…";
      message.dataset.state = "saving";
      var formData = new FormData();
      formData.append(config.uploadField || "image", file, file.name);
      if (config.nodeId) {
        formData.append("node_id", String(config.nodeId));
      }
      var altInput = block.querySelector('[data-block-field="alt"]');
      var captionInput = block.querySelector('[data-block-field="caption"]');
      formData.append("alt_text", altInput.value || "");
      formData.append("caption", captionInput.value || "");

      try {
        var headers = { Accept: "application/json" };
        if (csrfToken) {
          headers["X-CSRFToken"] = csrfToken;
        }
        var response = await fetch(uploadUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: headers,
          body: formData,
        });
        var result = await response.json().catch(function () {
          return {};
        });
        if (!response.ok || result.ok === false) {
          throw new Error(result.error || result.message || "이미지 업로드에 실패했습니다.");
        }
        var asset = result.asset || result;
        var assetId = asset.id ?? asset.assetId ?? result.asset_id ?? "";
        var assetUrl = safeMediaUrl(asset.url || result.url || "");
        if (!assetId || !assetUrl) {
          throw new Error("업로드 응답에 이미지 정보가 없습니다.");
        }
        block.querySelector('[data-block-field="asset_id"]').value = String(assetId);
        block.querySelector('[data-block-field="url"]').value = assetUrl;
        preview.src = assetUrl;
        preview.alt = altInput.value || "";
        message.textContent = "업로드 완료";
        message.dataset.state = "saved";
        markDirty();
      } catch (error) {
        preview.src = block.querySelector('[data-block-field="url"]').value || "";
        preview.hidden = !preview.getAttribute("src");
        message.textContent = error.message || "이미지 업로드에 실패했습니다.";
        message.dataset.state = "error";
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }

    function buildBlockBody(blockElement, block) {
      var body = createElement("div", "editor-block__body");

      if (block.type === "text") {
        var textEditor = createElement("div");
        configureRichEditor(textEditor, block.html, "텍스트 블록 내용");
        body.append(createToolbar(textEditor), textEditor);
      } else if (block.type === "image") {
        var assetInput = document.createElement("input");
        assetInput.type = "hidden";
        assetInput.value = block.asset_id || "";
        assetInput.dataset.blockField = "asset_id";
        var urlInput = document.createElement("input");
        urlInput.type = "hidden";
        urlInput.value = safeMediaUrl(block.url);
        urlInput.dataset.blockField = "url";

        var image = document.createElement("img");
        image.className = "editor-image-preview";
        image.dataset.imagePreview = "";
        image.src = safeMediaUrl(block.url);
        image.alt = block.alt || "";
        image.hidden = !image.getAttribute("src");

        var file = document.createElement("input");
        file.type = "file";
        file.accept = "image/jpeg,image/png,image/webp";
        file.dataset.imageUpload = "";
        var uploadStatus = createElement("span", "upload-status", "");
        uploadStatus.dataset.uploadStatus = "";
        uploadStatus.setAttribute("role", "status");

        var alt = createTextInput("", block.alt, "이미지를 설명해 주세요");
        alt.dataset.blockField = "alt";
        alt.addEventListener("input", function () {
          image.alt = alt.value;
        });
        var caption = createTextInput("", block.caption, "이미지 아래에 표시할 설명");
        caption.dataset.blockField = "caption";
        file.addEventListener("change", function () {
          if (file.files && file.files[0]) {
            uploadImage(blockElement, file.files[0]);
          }
        });
        body.append(
          assetInput,
          urlInput,
          image,
          createField("이미지 파일", file),
          uploadStatus,
          createField("대체 텍스트", alt),
          createField("캡션", caption)
        );
      } else if (block.type === "youtube") {
        var youtubeUrl = createTextInput("", block.url, "https://youtu.be/…");
        youtubeUrl.type = "url";
        youtubeUrl.inputMode = "url";
        youtubeUrl.dataset.blockField = "url";
        var youtubePreview = createElement("div", "embed-preview embed-preview--video");
        youtubePreview.dataset.youtubePreview = "";
        youtubeUrl.addEventListener("input", function () {
          createYoutubePreview(youtubePreview, youtubeUrl.value);
        });
        body.append(createField("YouTube 링크", youtubeUrl), youtubePreview);
        createYoutubePreview(youtubePreview, youtubeUrl.value);
      } else if (block.type === "sheet") {
        var sheetUrl = createTextInput(
          "",
          block.url,
          "https://docs.google.com/spreadsheets/d/…"
        );
        sheetUrl.type = "url";
        sheetUrl.inputMode = "url";
        sheetUrl.dataset.blockField = "url";
        var sheetRange = createTextInput("", block.range, "예: 무기목록!A1:F20");
        sheetRange.dataset.blockField = "range";
        var sheetHeight = document.createElement("input");
        sheetHeight.type = "number";
        sheetHeight.min = "240";
        sheetHeight.max = "1200";
        sheetHeight.step = "20";
        sheetHeight.value = String(Math.min(1200, Math.max(240, block.height || 480)));
        sheetHeight.dataset.blockField = "height";
        var sheetPreview = createElement("div", "embed-preview embed-preview--sheet");
        sheetPreview.dataset.sheetPreview = "";
        function refreshSheetPreview() {
          createSheetPreview(
            sheetPreview,
            sheetUrl.value,
            sheetRange.value,
            sheetHeight.value
          );
        }
        [sheetUrl, sheetRange, sheetHeight].forEach(function (input) {
          input.addEventListener("input", refreshSheetPreview);
        });
        body.append(
          createField("스프레드시트 링크", sheetUrl),
          createField("표시 범위", sheetRange),
          createField("높이(px)", sheetHeight),
          sheetPreview
        );
        refreshSheetPreview();
      } else if (block.type === "callout") {
        var tone = document.createElement("select");
        tone.dataset.blockField = "tone";
        [
          ["info", "정보"],
          ["note", "메모"],
          ["success", "완료"],
          ["warning", "주의"],
          ["danger", "위험"],
        ].forEach(function (optionData) {
          var option = document.createElement("option");
          option.value = optionData[0];
          option.textContent = optionData[1];
          tone.appendChild(option);
        });
        tone.value = block.tone;
        var calloutTitle = createTextInput("", block.title, "강조 상자 제목");
        calloutTitle.dataset.blockField = "title";
        var calloutEditor = createElement("div");
        calloutEditor.dataset.blockField = "html";
        configureRichEditor(calloutEditor, block.html, "강조 상자 내용");
        body.append(
          createField("종류", tone),
          createField("제목", calloutTitle),
          createToolbar(calloutEditor),
          calloutEditor
        );
      } else if (block.type === "divider") {
        var divider = document.createElement("hr");
        divider.className = "editor-divider-preview";
        body.appendChild(divider);
      }

      return body;
    }

    function createBlock(rawBlock) {
      var block = normalizeBlock(rawBlock);
      var article = createElement("article", "editor-block");
      article.dataset.blockId = block.id;
      article.dataset.blockType = block.type;
      article.setAttribute("role", "listitem");

      var header = createElement("header", "editor-block__header");
      var handle = createButton("⋮⋮", "editor-block__handle");
      handle.dataset.blockHandle = "";
      handle.draggable = true;
      handle.title = "드래그하여 순서 변경";
      handle.setAttribute("aria-label", BLOCK_LABELS[block.type] + " 블록 순서 변경");
      var label = createElement("strong", "editor-block__label", BLOCK_LABELS[block.type]);
      var actions = createElement("div", "editor-block__actions");
      [
        ["up", "위로", "↑"],
        ["down", "아래로", "↓"],
        ["duplicate", "복제", "복제"],
        ["remove", "삭제", "삭제"],
      ].forEach(function (definition) {
        var button = createButton(definition[2], "editor-block__action");
        button.dataset.blockAction = definition[0];
        button.title = definition[1];
        button.setAttribute("aria-label", BLOCK_LABELS[block.type] + " 블록 " + definition[1]);
        if (definition[0] === "remove") {
          button.dataset.removeBlock = "";
        }
        actions.appendChild(button);
      });
      header.append(handle, label, actions);
      article.append(header, buildBlockBody(article, block));
      return article;
    }

    function serializeBlock(block) {
      var type = normalizedType(block.dataset.blockType);
      var result = { id: block.dataset.blockId, type: type };
      if (type === "text") {
        result.html = sanitizeRichHtml(block.querySelector("[data-rich-editor]").innerHTML);
      } else if (type === "image") {
        result.asset_id = block.querySelector('[data-block-field="asset_id"]').value || null;
        result.url = block.querySelector('[data-block-field="url"]').value || "";
        result.alt = block.querySelector('[data-block-field="alt"]').value.trim();
        result.caption = block.querySelector('[data-block-field="caption"]').value.trim();
      } else if (type === "youtube") {
        result.url = block.querySelector('[data-block-field="url"]').value.trim();
      } else if (type === "sheet") {
        result.url = block.querySelector('[data-block-field="url"]').value.trim();
        result.range = block.querySelector('[data-block-field="range"]').value.trim();
        result.height = Math.min(
          1200,
          Math.max(
            240,
            Number(block.querySelector('[data-block-field="height"]').value) || 480
          )
        );
      } else if (type === "callout") {
        result.tone = block.querySelector('[data-block-field="tone"]').value;
        result.title = block.querySelector('[data-block-field="title"]').value.trim();
        result.html = sanitizeRichHtml(
          block.querySelector('[data-block-field="html"]').innerHTML
        );
      }
      var canonicalData = {};
      if (type === "text") {
        canonicalData.html = result.html;
      } else if (type === "image") {
        canonicalData.assetId = result.asset_id;
        canonicalData.url = result.url;
        canonicalData.alt = result.alt;
        canonicalData.caption = result.caption;
      } else if (type === "youtube") {
        canonicalData.url = result.url;
      } else if (type === "sheet") {
        canonicalData.url = result.url;
        canonicalData.range = result.range;
        canonicalData.height = result.height;
      } else if (type === "callout") {
        canonicalData.tone = result.tone;
        canonicalData.title = result.title;
        canonicalData.html = result.html;
      }
      result.data = canonicalData;
      return result;
    }

    function serializeTags() {
      if (!tagsInput) {
        return [];
      }
      if (tagsInput instanceof HTMLSelectElement && tagsInput.multiple) {
        return Array.from(tagsInput.selectedOptions, function (option) {
          return option.value.trim();
        }).filter(Boolean);
      }
      return String(tagsInput.value || "")
        .split(/[,\n]/)
        .map(function (tag) {
          return tag.trim();
        })
        .filter(function (tag, index, tags) {
          return tag && tags.indexOf(tag) === index;
        });
    }

    function serializeProperties() {
      if (!propertiesInput) {
        return { valid: true, value: {} };
      }
      if ("value" in propertiesInput) {
        var rawValue = String(propertiesInput.value || "").trim();
        if (!rawValue) {
          return { valid: true, value: {} };
        }
        try {
          var parsed = JSON.parse(rawValue);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("object required");
          }
          return { valid: true, value: parsed };
        } catch (error) {
          return {
            valid: false,
            value: {},
            message: "속성은 올바른 JSON 객체 형식이어야 합니다.",
          };
        }
      }

      var result = {};
      propertiesInput.querySelectorAll("[data-property-row]").forEach(function (row) {
        var keyInput = row.querySelector(
          '[data-property-name], [data-property-key-input], [name="property_key"]'
        );
        var valueInput = row.querySelector(
          '[data-property-value], [name="property_value"]'
        );
        var key = keyInput ? keyInput.value.trim() : String(row.dataset.propertyKey || "").trim();
        if (key && valueInput) {
          result[key] = valueInput.value;
        }
      });
      return { valid: true, value: result };
    }

    function payloadForSave(publish) {
      var properties = serializeProperties();
      if (!properties.valid) {
        return properties;
      }
      return {
        valid: true,
        value: {
          title: titleInput ? titleInput.value.trim() : "",
          summary: summaryInput ? summaryInput.value.trim() : "",
          parent: parentInput && parentInput.value ? parentInput.value : null,
          template: templateInput ? templateInput.value : "default",
          tags: serializeTags(),
          properties: properties.value,
          blocks: Array.from(
            blockList.querySelectorAll(":scope > .editor-block"),
            serializeBlock
          ),
          version: version,
          status: publish ? "published" : "draft",
          publish: Boolean(publish),
        },
      };
    }

    function friendlySavedTime(value) {
      var date = value ? new Date(value) : new Date();
      if (Number.isNaN(date.getTime())) {
        date = new Date();
      }
      return new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date);
    }

    async function performSave(publish, automatic) {
      var endpoint = saveUrl(publish);
      if (!endpoint) {
        setStatus("저장 주소가 설정되지 않았습니다.", "error");
        return;
      }
      if (publish && titleInput && !titleInput.value.trim()) {
        setStatus("게시하려면 페이지 제목을 입력해 주세요.", "error");
        titleInput.focus();
        return;
      }

      var serialized = payloadForSave(publish);
      if (!serialized.valid) {
        setStatus(serialized.message, "error");
        if (propertiesInput && typeof propertiesInput.focus === "function") {
          propertiesInput.focus();
        }
        return;
      }
      serialized.value.intent = publish ? "publish" : automatic ? "autosave" : "draft";

      var generation = changeCounter;
      saveInFlight = true;
      window.clearTimeout(autosaveTimer);
      if (saveDraftButton) {
        saveDraftButton.disabled = true;
      }
      if (publishButton) {
        publishButton.disabled = true;
      }
      setStatus(publish ? "게시 중…" : automatic ? "자동 저장 중…" : "저장 중…", "saving");

      try {
        var headers = {
          Accept: "application/json",
          "Content-Type": "application/json",
        };
        if (csrfToken) {
          headers["X-CSRFToken"] = csrfToken;
        }
        var response = await fetch(endpoint, {
          method: config.saveMethod || "POST",
          credentials: "same-origin",
          headers: headers,
          body: JSON.stringify(serialized.value),
        });
        var result = await response.json().catch(function () {
          return {};
        });
        if (response.status === 409) {
          conflict = true;
          throw new Error(
            result.errorMessage ||
              "다른 창에서 페이지가 수정되었습니다. 새로고침하기 전에 내용을 복사해 두세요."
          );
        }
        if (!response.ok || result.ok === false) {
          throw new Error(result.error || result.message || "저장하지 못했습니다.");
        }

        if (result.version !== undefined && result.version !== null) {
          version = Number(result.version);
          editor.dataset.version = String(version);
        }
        lastSavedCounter = Math.max(lastSavedCounter, generation);
        if (generation === changeCounter) {
          editor.dataset.dirty = "false";
        }
        conflict = false;
        setStatus(
          (publish ? "게시됨 · " : "저장됨 · ") + friendlySavedTime(result.savedAt),
          "saved"
        );

        var redirectUrl = result.redirectUrl || result.redirect_url;
        if ((publish || result.isNew || result.created) && redirectUrl) {
          window.location.assign(redirectUrl);
          return;
        }
      } catch (error) {
        setStatus(error.message || "저장하지 못했습니다.", conflict ? "conflict" : "error");
      } finally {
        saveInFlight = false;
        window.clearTimeout(autosaveTimer);
        if (saveDraftButton) {
          saveDraftButton.disabled = false;
        }
        if (publishButton) {
          publishButton.disabled = false;
        }

        if (conflict) {
          queuedIntent = null;
        }
        if (queuedIntent) {
          var nextIntent = queuedIntent;
          queuedIntent = null;
          window.setTimeout(function () {
            requestSave(nextIntent === "publish", nextIntent === "auto");
          }, 0);
        } else if (changeCounter > generation && !conflict) {
          autosaveTimer = window.setTimeout(function () {
            requestSave(false, true);
          }, AUTOSAVE_DELAY);
        }
      }
    }

    function requestSave(publish, automatic) {
      if (automatic && conflict) {
        return;
      }
      if (saveInFlight) {
        if (publish) {
          queuedIntent = "publish";
        } else if (!queuedIntent) {
          queuedIntent = automatic ? "auto" : "draft";
        }
        return;
      }
      if (automatic && changeCounter <= lastSavedCounter) {
        return;
      }
      performSave(Boolean(publish), Boolean(automatic));
    }

    function focusFirstBlockField(block) {
      var target = block.querySelector(
        "[data-rich-editor], input:not([type=hidden]), select, textarea"
      );
      if (target) {
        target.focus();
      }
    }

    function updatePropertyEmptyState() {
      if (!propertiesInput || "value" in propertiesInput) {
        return;
      }
      propertiesInput.classList.toggle(
        "is-empty",
        !propertiesInput.querySelector("[data-property-row]")
      );
    }

    function createPropertyRow() {
      var row = createElement("div", "property-row");
      row.dataset.propertyRow = "";
      var key = createTextInput("", "", "속성 이름");
      key.name = "property_key";
      key.setAttribute("aria-label", "속성 이름");
      var value = createTextInput("", "", "값");
      value.name = "property_value";
      value.setAttribute("aria-label", "속성 값");
      var remove = createButton("×", "property-row__remove");
      remove.dataset.removeProperty = "";
      remove.setAttribute("aria-label", "속성 삭제");
      row.append(key, value, remove);
      return row;
    }

    function insertBlock(type, reference) {
      var block = createBlock({ type: normalizedType(type), id: generateBlockId() });
      if (reference && reference.parentElement === blockList) {
        blockList.insertBefore(block, reference.nextElementSibling);
      } else {
        blockList.appendChild(block);
      }
      updateBlockButtons();
      markDirty();
      focusFirstBlockField(block);
      block.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return block;
    }

    initialBlocks.forEach(function (block) {
      blockList.appendChild(createBlock(block));
    });
    blockList.setAttribute("role", "list");
    updateBlockButtons();
    initialized = true;

    addBlockButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        insertBlock(button.dataset.addBlock || "text");
      });
    });

    if (propertiesInput && !("value" in propertiesInput)) {
      propertiesInput.addEventListener("click", function (event) {
        var remove = event.target.closest("[data-remove-property]");
        if (!remove) {
          return;
        }
        var row = remove.closest("[data-property-row]");
        if (row) {
          row.remove();
          updatePropertyEmptyState();
          markDirty();
        }
      });
      updatePropertyEmptyState();
    }
    if (addPropertyButton && propertiesInput && !("value" in propertiesInput)) {
      addPropertyButton.addEventListener("click", function () {
        var row = createPropertyRow();
        propertiesInput.appendChild(row);
        updatePropertyEmptyState();
        markDirty();
        row.querySelector('[name="property_key"]').focus();
      });
    }

    blockList.addEventListener("click", function (event) {
      var button = event.target.closest("[data-block-action]");
      if (!button) {
        return;
      }
      var block = button.closest(".editor-block");
      var action = button.dataset.blockAction;
      if (!block || !action) {
        return;
      }
      if (action === "up" && block.previousElementSibling) {
        blockList.insertBefore(block, block.previousElementSibling);
        markDirty();
      } else if (action === "down" && block.nextElementSibling) {
        blockList.insertBefore(block.nextElementSibling, block);
        markDirty();
      } else if (action === "duplicate") {
        var cloneData = serializeBlock(block);
        cloneData.id = generateBlockId();
        var clone = createBlock(cloneData);
        blockList.insertBefore(clone, block.nextElementSibling);
        markDirty();
        focusFirstBlockField(clone);
      } else if (action === "remove") {
        if (window.confirm("이 블록을 삭제할까요?")) {
          block.remove();
          markDirty();
        }
      }
      updateBlockButtons();
    });

    blockList.addEventListener("dragstart", function (event) {
      var handle = event.target.closest("[data-block-handle]");
      if (!handle) {
        event.preventDefault();
        return;
      }
      draggedBlock = handle.closest(".editor-block");
      if (!draggedBlock) {
        return;
      }
      dragChanged = false;
      draggedBlock.classList.add("is-dragging");
      draggedBlock.setAttribute("aria-grabbed", "true");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedBlock.dataset.blockId);
    });

    blockList.addEventListener("dragover", function (event) {
      if (!draggedBlock) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      var target = event.target.closest(".editor-block");
      if (!target || target === draggedBlock) {
        if (!target && blockList.lastElementChild !== draggedBlock) {
          blockList.appendChild(draggedBlock);
          dragChanged = true;
        }
        return;
      }
      var rectangle = target.getBoundingClientRect();
      var insertAfter = event.clientY > rectangle.top + rectangle.height / 2;
      var reference = insertAfter ? target.nextElementSibling : target;
      if (reference !== draggedBlock && draggedBlock.nextElementSibling !== reference) {
        blockList.insertBefore(draggedBlock, reference);
        dragChanged = true;
      }
    });

    blockList.addEventListener("drop", function (event) {
      if (draggedBlock) {
        event.preventDefault();
      }
    });

    blockList.addEventListener("dragend", function () {
      if (draggedBlock) {
        draggedBlock.classList.remove("is-dragging");
        draggedBlock.setAttribute("aria-grabbed", "false");
      }
      if (dragChanged) {
        markDirty();
      }
      draggedBlock = null;
      dragChanged = false;
      updateBlockButtons();
    });

    var observedInputs = new Set([editor, blockList]);
    [titleInput, summaryInput, templateInput, tagsInput, propertiesInput, parentInput].forEach(
      function (input) {
        if (input && !observedInputs.has(input) && !editor.contains(input)) {
          input.addEventListener("input", markDirty);
          input.addEventListener("change", markDirty);
        }
      }
    );
    editor.addEventListener("input", markDirty);
    editor.addEventListener("change", function (event) {
      if (!event.target.matches('[type="file"]')) {
        markDirty();
      }
    });
    if (!editor.contains(blockList)) {
      blockList.addEventListener("input", markDirty);
      blockList.addEventListener("change", function (event) {
        if (!event.target.matches('[type="file"]')) {
          markDirty();
        }
      });
    }

    if (saveDraftButton) {
      saveDraftButton.addEventListener("click", function (event) {
        event.preventDefault();
        requestSave(false, false);
      });
    }
    if (publishButton) {
      publishButton.addEventListener("click", function (event) {
        event.preventDefault();
        requestSave(true, false);
      });
    }
    if (editor.tagName === "FORM") {
      editor.addEventListener("submit", function (event) {
        if (
          event.submitter &&
          event.submitter !== saveDraftButton &&
          event.submitter !== publishButton
        ) {
          return;
        }
        event.preventDefault();
        requestSave(event.submitter === publishButton, false);
      });
    }

    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        requestSave(false, false);
      }
    });
    window.addEventListener("beforeunload", function (event) {
      if (changeCounter > lastSavedCounter) {
        event.preventDefault();
        event.returnValue = "";
      }
    });

    setStatus("편집 준비됨", "idle");
  });
})();
