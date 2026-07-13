const HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

export function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

export function safeExternalUrl(value = "") {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

export function sanitizeUserHtml(value = "") {
  const template = document.createElement("template");
  template.innerHTML = String(value);
  template.content.querySelectorAll("script,style,iframe,object,embed,form,link,meta").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const unsafeUrl = ["href", "src", "xlink:href"].includes(name) && !safeExternalUrl(attribute.value) && !attribute.value.startsWith("#");
      if (name.startsWith("on") || unsafeUrl || name === "srcdoc") element.removeAttribute(attribute.name);
    });
  });
  return template.innerHTML;
}

function formatDate(value, withTime = false) {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "기록 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function relativeTime(value) {
  if (!value) return "아직 없음";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "아직 없음";
  const seconds = Math.round((time - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, amount] of units) {
    if (Math.abs(seconds) >= amount || unit === "minute") return formatter.format(Math.round(seconds / amount), unit);
  }
  return "방금";
}

function statusLabel(status) {
  return status === "published" ? "게시됨" : "초안";
}

function sortByOrder(items = []) {
  return [...items].sort((a, b) => {
    const left = String(a.orderKey || "");
    const right = String(b.orderKey || "");
    if (left < right) return -1;
    if (left > right) return 1;
    return String(a.title || "").localeCompare(String(b.title || ""), "ko");
  });
}

function nodeChildren(nodes, parentId) {
  return sortByOrder(nodes.filter((node) => (node.parentId || null) === (parentId || null) && !node.deletedAt));
}

function renderTreeBranch(nodes, parentId = null, level = 0, activeId = "") {
  const children = nodeChildren(nodes, parentId);
  if (!children.length) return "";
  return `<ul class="nav-tree__list ${level ? "nav-tree__list--nested" : ""}" role="list">
    ${children
      .map((node) => {
        const descendants = node.kind === "folder" ? renderTreeBranch(nodes, node.id, level + 1, activeId) : "";
        const href = node.kind === "folder" ? `#/folder/${encodeURIComponent(node.id)}` : `#/page/${encodeURIComponent(node.id)}`;
        return `<li class="nav-tree__item" data-node-id="${escapeHtml(node.id)}">
          <a class="nav-tree__link ${node.id === activeId ? "is-active" : ""}" href="${href}" ${node.id === activeId ? 'aria-current="page"' : ""}>
            <span class="tree-symbol tree-symbol--${node.kind}" aria-hidden="true"></span>
            <span>${escapeHtml(node.title || "제목 없음")}</span>
            ${node.kind === "folder" ? `<small>${nodeChildren(nodes, node.id).length}</small>` : ""}
          </a>
          ${descendants}
        </li>`;
      })
      .join("")}
  </ul>`;
}

function renderSidebar(state) {
  const activeId = state.route.params?.id || "";
  const tree = renderTreeBranch(state.nodes, null, 0, activeId);
  return `<aside class="sidebar ${state.drawerOpen ? "is-open" : ""}" id="site-navigation" aria-label="위키 탐색">
    <div class="sidebar__mobile-head">
      <span class="eyebrow">ARCHIVE INDEX</span>
      <button class="icon-button" type="button" data-action="close-drawer" aria-label="탐색 메뉴 닫기"><span class="css-icon css-icon--close" aria-hidden="true"></span></button>
    </div>
    <nav class="primary-nav" aria-label="주요 메뉴">
      <a class="primary-nav__item ${state.route.name === "home" ? "is-active" : ""}" href="#/home">
        <span class="nav-glyph nav-glyph--home" aria-hidden="true"></span><span>전체 기록</span>
      </a>
      <a class="primary-nav__item ${state.route.name === "structure" ? "is-active" : ""}" href="#/structure">
        <span class="nav-glyph nav-glyph--tree" aria-hidden="true"></span><span>기록 구조</span>
      </a>
      <a class="primary-nav__item ${state.route.name === "trash" ? "is-active" : ""}" href="#/trash">
        <span class="nav-glyph nav-glyph--trash" aria-hidden="true"></span><span>휴지통</span>
        ${state.trashCount ? `<small class="nav-count">${state.trashCount}</small>` : ""}
      </a>
    </nav>
    <div class="sidebar__section-head"><span>주제 인덱스</span><i class="signal-dot ${state.online ? "" : "is-offline"}" aria-hidden="true"></i></div>
    <nav class="nav-tree" aria-label="문서 트리">
      ${tree || `<div class="nav-tree__empty"><span class="tree-symbol tree-symbol--folder" aria-hidden="true"></span><p>아직 기록이 없습니다.</p><button type="button" data-action="open-create" data-kind="folder">첫 폴더 만들기</button></div>`}
    </nav>
    <div class="sidebar__sync-card">
      <div><span class="sync-orb sync-orb--${escapeHtml(state.syncTone)}" aria-hidden="true"></span><strong>${escapeHtml(state.syncLabel)}</strong></div>
      <p>${state.unsyncedCount ? `<b>${state.unsyncedCount}개</b> 변경이 PC 동기화를 기다리는 중` : "이 기기의 변경이 모두 정리됨"}</p>
      <a href="#/settings">동기화 센터 <span aria-hidden="true">→</span></a>
    </div>
    <footer class="sidebar__footer"><span>LOCAL ARCHIVE</span><span>${escapeHtml(state.platform.shortLabel)}</span></footer>
  </aside>`;
}

function renderTopbar(state) {
  return `<header class="topbar">
    <div class="topbar__inner">
      <button class="icon-button topbar__menu" type="button" data-action="open-drawer" aria-controls="site-navigation" aria-expanded="${state.drawerOpen}">
        <span class="css-icon css-icon--menu" aria-hidden="true"></span><span class="sr-only">탐색 메뉴 열기</span>
      </button>
      <a class="brand" href="#/home" aria-label="Title Placeholder 홈">
        <span class="brand__mark" aria-hidden="true"><i></i></span>
        <span class="brand__copy"><strong>Title:Placeholder</strong><small>LOCAL DEVELOPMENT ARCHIVE</small></span>
      </a>
      <form class="global-search" data-search-form role="search">
        <button type="submit" aria-label="검색"><span class="search-icon" aria-hidden="true"></span></button>
        <label class="sr-only" for="global-query">전체 기록 검색</label>
        <input id="global-query" name="q" type="search" value="${escapeHtml(state.searchQuery || "")}" placeholder="제목, 본문, 태그 검색" autocomplete="off" />
        <kbd aria-hidden="true">/</kbd>
      </form>
      <nav class="topbar__actions" aria-label="빠른 작업">
        <button class="sync-pill sync-pill--${escapeHtml(state.syncTone)}" type="button" data-action="sync-now" aria-label="${state.unsyncedCount}개 변경 동기화">
          <span class="sync-orb sync-orb--${escapeHtml(state.syncTone)}" aria-hidden="true"></span>
          <span class="sync-pill__label">${state.unsyncedCount ? `${state.unsyncedCount} 대기` : state.online ? "동기화됨" : "오프라인"}</span>
        </button>
        <button class="button button--primary topbar__create" type="button" data-action="open-create" data-kind="page"><span aria-hidden="true">＋</span><span>새 기록</span></button>
        <a class="icon-button" href="#/settings" aria-label="설정 및 동기화"><span class="css-icon css-icon--settings" aria-hidden="true"></span></a>
      </nav>
    </div>
  </header>`;
}

function renderMobileNav(state) {
  return `<nav class="mobile-nav" aria-label="모바일 빠른 메뉴">
    <a class="${state.route.name === "home" ? "is-active" : ""}" href="#/home"><span class="nav-glyph nav-glyph--home" aria-hidden="true"></span><span>홈</span></a>
    <button type="button" data-action="focus-search"><span class="search-icon" aria-hidden="true"></span><span>검색</span></button>
    <button class="mobile-nav__create" type="button" data-action="open-create" data-kind="page"><span aria-hidden="true">＋</span><span>새 기록</span></button>
    <a class="${state.route.name === "settings" ? "is-active" : ""}" href="#/settings"><span class="nav-glyph nav-glyph--sync" aria-hidden="true"></span><span>동기화</span>${state.unsyncedCount ? `<i>${state.unsyncedCount}</i>` : ""}</a>
  </nav>`;
}

function renderOfflineBanner(state) {
  if (state.online) return "";
  return `<div class="network-banner" role="status">
    <span class="network-banner__mark" aria-hidden="true"></span>
    <p><strong>오프라인 모드</strong><span>계속 편집할 수 있습니다. 변경 내용은 이 기기에 안전하게 보관됩니다.</span></p>
    <span>${state.unsyncedCount}개 대기</span>
  </div>`;
}

function renderInstallBanner(state) {
  if (state.platform.isNative || state.installDismissed || !state.installAvailable) return "";
  return `<aside class="install-banner" aria-label="앱 설치 안내">
    <span class="install-banner__mark" aria-hidden="true"><i></i></span>
    <p><strong>이 기기에 위키 설치</strong><span>홈 화면에서 바로 열고 오프라인으로 기록하세요.</span></p>
    <button class="button button--secondary" type="button" data-action="install-app">설치</button>
    <button class="icon-button" type="button" data-action="dismiss-install" aria-label="설치 안내 닫기"><span class="css-icon css-icon--close" aria-hidden="true"></span></button>
  </aside>`;
}

function renderTopicCard(node, index, nodes) {
  const children = nodeChildren(nodes, node.id);
  const href = node.kind === "folder" ? `#/folder/${encodeURIComponent(node.id)}` : `#/page/${encodeURIComponent(node.id)}`;
  return `<article class="topic-card">
    <a href="${href}" aria-label="${escapeHtml(node.title)} 열기">
      <div class="topic-card__head"><span>${String(index + 1).padStart(2, "0")}</span><i class="topic-card__signal" aria-hidden="true"></i><small>${node.kind === "folder" ? "SECTOR" : "RECORD"}</small></div>
      <span class="topic-card__glyph" aria-hidden="true"><i></i></span>
      <div class="topic-card__body"><h3>${escapeHtml(node.title || "제목 없음")}</h3><p>${escapeHtml(node.summary || "이 구역에 프로젝트 기록을 모아 두세요.")}</p></div>
      <footer><span>${children.length} ENTRIES</span><time datetime="${escapeHtml(node.updatedAt || "")}">${relativeTime(node.updatedAt)}</time><i aria-hidden="true">→</i></footer>
    </a>
  </article>`;
}

function renderEmptyHome() {
  return `<section class="first-record" aria-labelledby="first-record-title">
    <div class="first-record__visual" aria-hidden="true"><span class="orbit orbit--one"></span><span class="orbit orbit--two"></span><span class="orbit-core"></span></div>
    <div><span class="eyebrow">ARCHIVE AWAITING INPUT</span><h2 id="first-record-title">첫 번째 기록 구역을 만드세요</h2><p>세계관, 전투 시스템, 아이템처럼 큰 주제를 폴더로 나눈 뒤 세부 문서를 채워 넣을 수 있습니다.</p><div class="button-row"><button class="button button--primary" type="button" data-action="open-create" data-kind="folder">첫 폴더 만들기</button><button class="button button--secondary" type="button" data-action="open-import">백업 가져오기</button></div></div>
  </section>`;
}

function renderRecentRow(node, index) {
  const href = node.kind === "folder" ? `#/folder/${encodeURIComponent(node.id)}` : `#/page/${encodeURIComponent(node.id)}`;
  return `<a class="record-row" href="${href}">
    <span class="record-row__index">${String(index + 1).padStart(2, "0")}</span>
    <span class="record-row__main"><strong>${escapeHtml(node.title)}</strong><small>${escapeHtml(node.summary || (node.kind === "folder" ? "주제 폴더" : "요약이 아직 없습니다."))}</small></span>
    <span class="record-row__kind">${node.kind === "folder" ? "FOLDER" : statusLabel(node.status)}</span>
    <time datetime="${escapeHtml(node.updatedAt || "")}">${formatDate(node.updatedAt)}</time><span aria-hidden="true">↗</span>
  </a>`;
}

function renderHome(state) {
  const roots = nodeChildren(state.nodes, null);
  const recent = [...state.nodes].filter((node) => !node.deletedAt).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).slice(0, 6);
  return `<div class="page page--home">
    <section class="home-hero" aria-labelledby="home-title">
      <div class="home-hero__copy">
        <span class="eyebrow"><i></i> OFFLINE KNOWLEDGE SYSTEM</span>
        <h1 id="home-title">생각은 현장에서,<br /><em>기록은 당신의 기기에.</em></h1>
        <p>인터넷이 없어도 설계와 발견을 남기세요. 집의 PC가 깨어나면 모든 변경이 하나의 아카이브로 합쳐집니다.</p>
        <div class="home-hero__actions"><button class="button button--primary" type="button" data-action="open-create" data-kind="page">새 기록 작성</button><a class="button button--secondary" href="#/structure">구조 정리</a></div>
        <dl class="hero-metrics">
          <div><dt>RECORDS</dt><dd>${state.activeCount}</dd></div>
          <div><dt>LOCAL CHANGES</dt><dd class="${state.unsyncedCount ? "is-alert" : ""}">${state.unsyncedCount}</dd></div>
          <div><dt>LAST SYNC</dt><dd>${relativeTime(state.syncStatus.lastSyncedAt)}</dd></div>
        </dl>
      </div>
      <div class="home-hero__visual" aria-label="로컬 아카이브 상태">
        <div class="orbital-display" aria-hidden="true"><span class="orbit orbit--one"></span><span class="orbit orbit--two"></span><span class="orbit orbit--three"></span><span class="orbit-scan"></span><span class="orbit-core"></span></div>
        <div class="system-readout"><span>SIGNAL / ${state.online ? "ONLINE" : "LOCAL"}</span><strong>${state.unsyncedCount ? `${state.unsyncedCount} UNSYNCED` : "ARCHIVE STABLE"}</strong><small>${escapeHtml(state.platform.label)} · ${state.syncStatus.running ? "LINK ACTIVE" : "LINK STANDBY"}</small></div>
      </div>
    </section>

    <section class="section" aria-labelledby="topics-title">
      <header class="section-heading"><div><span class="eyebrow">PRIMARY INDEX</span><h2 id="topics-title">주제 구역</h2></div><div class="section-heading__actions"><span>${roots.length} SECTORS</span><button class="text-button" type="button" data-action="open-create" data-kind="folder">＋ 폴더 추가</button></div></header>
      ${roots.length ? `<div class="topic-grid">${roots.map((node, index) => renderTopicCard(node, index, state.nodes)).join("")}</div>` : renderEmptyHome()}
    </section>

    <section class="section recent-section" aria-labelledby="recent-title">
      <header class="section-heading"><div><span class="eyebrow">LATEST TRANSMISSIONS</span><h2 id="recent-title">최근 갱신한 기록</h2></div><a class="text-button" href="#/search">전체 검색 <span aria-hidden="true">→</span></a></header>
      <div class="record-list">${recent.length ? recent.map(renderRecentRow).join("") : `<div class="empty-inline"><span class="signal-line" aria-hidden="true"></span><p>아직 갱신된 기록이 없습니다.</p></div>`}</div>
    </section>
  </div>`;
}

function youtubeId(value = "") {
  const text = String(value).trim();
  const direct = text.match(/^[\w-]{11}$/)?.[0];
  if (direct) return direct;
  try {
    const url = new URL(text);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0]?.slice(0, 11) || "";
    return url.searchParams.get("v")?.slice(0, 11) || url.pathname.match(/\/(?:embed|shorts)\/([\w-]{11})/)?.[1] || "";
  } catch {
    return "";
  }
}

function googleSheetEmbedUrl(value = "", range = "") {
  const href = safeExternalUrl(value);
  if (!href) return "";
  try {
    const source = new URL(href);
    if (source.hostname !== "docs.google.com") return "";
    const publishedId = source.pathname.match(/\/spreadsheets\/d\/e\/([\w-]+)/)?.[1];
    const documentId = source.pathname.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];
    if (!publishedId && !documentId) return "";
    const embed = publishedId
      ? new URL(`https://docs.google.com/spreadsheets/d/e/${publishedId}/pubhtml`)
      : new URL(`https://docs.google.com/spreadsheets/d/${documentId}/preview`);
    embed.searchParams.set("widget", "true");
    embed.searchParams.set("headers", "false");
    embed.searchParams.set("chrome", "false");
    const hashParameters = new URLSearchParams(source.hash.replace(/^#/, ""));
    const gid = source.searchParams.get("gid") || hashParameters.get("gid");
    if (gid && /^\d+$/.test(gid)) embed.searchParams.set("gid", gid);
    if (String(range).trim()) embed.searchParams.set("range", String(range).trim().slice(0, 200));
    return embed.href;
  } catch {
    return "";
  }
}

function renderReadBlock(block, state) {
  const data = block.data || {};
  const rawType = block.blockType || block.type || "text";
  const blockType = rawType === "rich_text" ? "text" : rawType === "google_sheet" ? "sheet" : rawType;
  if (blockType === "text") {
    const html = sanitizeUserHtml(data.html || escapeHtml(data.text || ""));
    return `<section class="content-block content-block--text rich-content" data-block-id="${escapeHtml(block.id)}">${html || "<p><em>빈 텍스트 블록</em></p>"}</section>`;
  }
  if (blockType === "callout") {
    const tone = ["info", "warning", "danger", "success"].includes(data.tone) ? data.tone : "info";
    return `<aside class="content-block callout callout--${tone}"><span class="callout__mark" aria-hidden="true">${tone === "warning" ? "!" : tone === "danger" ? "×" : tone === "success" ? "✓" : "i"}</span><div><strong>${escapeHtml(data.title || "참고")}</strong><p>${escapeHtml(data.text || "내용을 입력하세요.")}</p></div></aside>`;
  }
  if (blockType === "divider") return `<div class="content-divider" role="separator"><span></span><i></i><span></span></div>`;
  if (blockType === "image") {
    return `<figure class="content-block image-block" data-asset-id="${escapeHtml(data.assetId || "")}">
      <div class="image-block__frame">${data.previewUrl ? `<img src="${escapeHtml(data.previewUrl)}" alt="${escapeHtml(data.alt || "")}" />` : `<div class="image-placeholder"><span class="css-icon css-icon--image" aria-hidden="true"></span><p>${data.assetId ? "이미지 불러오는 중…" : "이미지가 연결되지 않았습니다"}</p></div>`}</div>
      ${data.caption ? `<figcaption>${escapeHtml(data.caption)}</figcaption>` : ""}
    </figure>`;
  }
  if (blockType === "youtube") {
    const id = youtubeId(data.url || data.videoId || "");
    const href = safeExternalUrl(data.url || (id ? `https://youtu.be/${id}` : ""));
    return `<figure class="content-block embed-block">
      <div class="embed-block__frame">
        ${id && state.online ? `<iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(id)}" title="${escapeHtml(data.title || "YouTube 영상")}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>` : `<div class="embed-placeholder"><span class="embed-placeholder__type">YT</span><div><strong>${state.online ? "YouTube 링크를 확인해 주세요" : "오프라인에서는 영상을 재생할 수 없습니다"}</strong><p>${escapeHtml(data.title || href || "영상 URL 없음")}</p></div>${href ? `<button type="button" class="button button--secondary" data-action="open-external" data-url="${escapeHtml(href)}">외부에서 열기</button>` : ""}</div>`}
      </div>${data.caption ? `<figcaption>${escapeHtml(data.caption)}</figcaption>` : ""}
    </figure>`;
  }
  if (blockType === "sheet") {
    const href = safeExternalUrl(data.url || "");
    const embedUrl = googleSheetEmbedUrl(data.url || "", data.range || "");
    return `<section class="content-block sheet-block">
      <header><span class="sheet-block__icon" aria-hidden="true">▦</span><div><span>GOOGLE SHEETS REFERENCE</span><h3>${escapeHtml(data.title || "연결된 스프레드시트")}</h3></div><span class="status-chip status-chip--${state.online ? "published" : "draft"}">${state.online ? "온라인" : "오프라인"}</span></header>
      ${embedUrl && state.online ? `<div class="sheet-block__embed"><iframe src="${escapeHtml(embedUrl)}" title="${escapeHtml(data.title || "Google Sheets 문서")}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe></div>` : `<div class="sheet-block__offline"><span aria-hidden="true">▦</span><p>${state.online ? "공개 Google Sheets 링크를 입력하면 이곳에 표가 표시됩니다." : "오프라인에서는 시트 링크와 범위만 확인할 수 있습니다."}</p></div>`}
      <dl><div><dt>범위</dt><dd>${escapeHtml(data.range || "전체 시트")}</dd></div><div><dt>링크</dt><dd>${escapeHtml(href ? new URL(href).hostname : "연결되지 않음")}</dd></div></dl>
      <div class="sheet-block__actions">${href ? `<button class="button button--secondary" type="button" data-action="open-external" data-url="${escapeHtml(href)}">시트 열기 <span aria-hidden="true">↗</span></button>` : ""}<small>오프라인에서도 링크와 범위 정보는 보존됩니다.</small></div>
    </section>`;
  }
  return `<section class="content-block unknown-block"><strong>${escapeHtml(blockType)} 블록</strong><p>현재 버전에서 표시할 수 없는 형식입니다. 데이터는 그대로 보존됩니다.</p></section>`;
}

function renderFolder(state) {
  const node = state.activeNode;
  if (!node) return renderNotFound();
  const children = nodeChildren(state.nodes, node.id);
  const ancestors = state.getAncestors(node.id);
  return `<div class="page page--folder">
    <nav class="breadcrumbs" aria-label="현재 위치"><a href="#/home">ARCHIVE</a>${ancestors.map((item) => `<span>/</span><a href="#/folder/${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a>`).join("")}<span>/</span><span aria-current="page">${escapeHtml(node.title)}</span></nav>
    <header class="folder-hero">
      <div class="folder-hero__glyph" aria-hidden="true"><span></span><i></i></div>
      <div><span class="eyebrow">SECTOR DIRECTORY</span><h1>${escapeHtml(node.title)}</h1><p>${escapeHtml(node.summary || "이 구역에 속한 기록을 탐색합니다.")}</p><div class="meta-line"><span>${children.length} ENTRIES</span><span>UPDATED ${formatDate(node.updatedAt)}</span><span class="status-chip status-chip--${escapeHtml(node.status)}">${statusLabel(node.status)}</span></div></div>
      <div class="folder-hero__actions"><button class="button button--primary" type="button" data-action="open-create" data-kind="page" data-parent-id="${escapeHtml(node.id)}">＋ 문서 추가</button><button class="button button--secondary" type="button" data-action="open-create" data-kind="folder" data-parent-id="${escapeHtml(node.id)}">하위 폴더</button><button class="icon-button" type="button" data-action="edit-node-meta" data-node-id="${escapeHtml(node.id)}" aria-label="폴더 정보 편집"><span class="css-icon css-icon--edit" aria-hidden="true"></span></button></div>
    </header>
    <section class="section" aria-labelledby="folder-content-title"><header class="section-heading"><div><span class="eyebrow">CONNECTED RECORDS</span><h2 id="folder-content-title">포함된 기록</h2></div><a class="text-button" href="#/structure">순서 및 구조 편집 →</a></header>
      ${children.length ? `<div class="folder-list">${children.map((child, index) => renderRecentRow(child, index)).join("")}</div>` : `<div class="empty-panel"><span class="empty-panel__signal" aria-hidden="true"></span><h3>이 구역은 아직 비어 있습니다</h3><p>새 문서나 하위 폴더를 만들어 설계 기록을 시작하세요.</p><button class="button button--primary" type="button" data-action="open-create" data-kind="page" data-parent-id="${escapeHtml(node.id)}">첫 문서 만들기</button></div>`}
    </section>
  </div>`;
}

function renderPage(state) {
  const node = state.activeNode;
  if (!node) return renderNotFound();
  const ancestors = state.getAncestors(node.id);
  const blocks = sortByOrder(state.activeBlocks || []);
  return `<article class="page page--document">
    <nav class="breadcrumbs" aria-label="현재 위치"><a href="#/home">ARCHIVE</a>${ancestors.map((item) => `<span>/</span><a href="#/folder/${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a>`).join("")}<span>/</span><span aria-current="page">${escapeHtml(node.title)}</span></nav>
    <header class="document-header">
      <div class="document-header__meta"><span class="eyebrow">PROJECT RECORD</span><span class="status-chip status-chip--${escapeHtml(node.status)}"><i aria-hidden="true"></i>${statusLabel(node.status)}</span></div>
      <h1>${escapeHtml(node.title)}</h1><p>${escapeHtml(node.summary || "요약이 아직 없습니다.")}</p>
      <div class="document-header__footer"><div class="tag-list">${(node.tags || []).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("") || "<span>#기록</span>"}</div><div><span>UPDATED ${formatDate(node.updatedAt)}</span><span>LOCAL COPY</span></div></div>
      <div class="document-header__actions"><a class="button button--primary" href="#/edit/${encodeURIComponent(node.id)}">편집</a><a class="button button--secondary" href="#/revisions/${encodeURIComponent(node.id)}">변경 이력</a><button class="icon-button icon-button--danger" type="button" data-action="trash-node" data-node-id="${escapeHtml(node.id)}" aria-label="휴지통으로 이동"><span class="nav-glyph nav-glyph--trash" aria-hidden="true"></span></button></div>
    </header>
    ${Object.keys(node.properties || {}).length ? `<dl class="property-grid">${Object.entries(node.properties).map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : ""}
    <div class="document-content">${blocks.length ? blocks.map((block) => renderReadBlock(block, state)).join("") : `<div class="empty-panel"><span class="empty-panel__signal" aria-hidden="true"></span><h2>아직 본문이 없습니다</h2><p>편집기에서 텍스트, 이미지, 영상이나 시트 참조를 추가하세요.</p><a class="button button--primary" href="#/edit/${encodeURIComponent(node.id)}">첫 블록 추가</a></div>`}</div>
    <footer class="document-end"><span>END OF RECORD</span><i aria-hidden="true"></i><span>${escapeHtml(node.id.slice(0, 8).toUpperCase())}</span></footer>
  </article>`;
}

function renderSearch(state) {
  const query = state.searchQuery || "";
  const results = state.searchResults || [];
  return `<div class="page page--search">
    <header class="page-heading"><span class="eyebrow">ARCHIVE SCAN</span><h1>전체 기록 검색</h1><p>제목, 본문, 태그와 속성에서 필요한 기록을 찾습니다. 오프라인에서도 기기에 저장된 모든 문서를 검색할 수 있습니다.</p></header>
    <form class="search-hero" data-search-form role="search"><span class="search-icon" aria-hidden="true"></span><label class="sr-only" for="page-search">기록 검색</label><input id="page-search" name="q" type="search" value="${escapeHtml(query)}" placeholder="예: AR-17, 전투 밸런스, VOID" autofocus /><button class="button button--primary" type="submit">검색</button></form>
    <div class="search-summary"><span>${query ? `“${escapeHtml(query)}” 검색 결과` : "최근 기록"}</span><strong>${results.length} RECORDS</strong></div>
    <section class="search-results" aria-label="검색 결과">
      ${results.length ? results.map((result, index) => `<article class="search-result"><span class="search-result__index">${String(index + 1).padStart(2, "0")}</span><div><div class="search-result__meta"><span>${result.kind === "folder" ? "FOLDER" : "PAGE"}</span><span>${statusLabel(result.status)}</span><time>${formatDate(result.updatedAt)}</time></div><h2><a href="${result.kind === "folder" ? `#/folder/${encodeURIComponent(result.id)}` : `#/page/${encodeURIComponent(result.id)}`}">${escapeHtml(result.title)}</a></h2><p>${escapeHtml(result.excerpt || result.summary || "본문 미리보기가 없습니다.")}</p><div class="tag-list">${(result.tags || []).slice(0, 4).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</div></div><a class="search-result__open" href="${result.kind === "folder" ? `#/folder/${encodeURIComponent(result.id)}` : `#/page/${encodeURIComponent(result.id)}`}" aria-label="${escapeHtml(result.title)} 열기">→</a></article>`).join("") : `<div class="empty-panel"><span class="radar-pulse" aria-hidden="true"><i></i></span><h2>${query ? "일치하는 기록이 없습니다" : "검색어를 입력하세요"}</h2><p>${query ? "다른 단어를 사용하거나 새 기록을 만들어 보세요." : "기기의 로컬 저장소를 즉시 검색합니다."}</p>${query ? `<button class="button button--secondary" type="button" data-action="open-create" data-kind="page" data-title="${escapeHtml(query)}">“${escapeHtml(query)}” 문서 만들기</button>` : ""}</div>`}
    </section>
  </div>`;
}

function renderStructureNode(node, nodes, depth = 0) {
  const children = nodeChildren(nodes, node.id);
  const kindLabel = node.kind === "folder" ? (depth ? "하위 주제" : "대주제") : "문서";
  return `<li class="structure-item" data-node-id="${escapeHtml(node.id)}" data-parent-id="${escapeHtml(node.parentId || "")}" data-kind="${escapeHtml(node.kind)}" draggable="true">
    <div class="structure-row structure-row--${escapeHtml(node.kind)}" style="--tree-depth:${Math.min(depth, 6)}">
      <button class="drag-handle" type="button" data-drag-handle aria-label="${escapeHtml(node.title)} 끌어서 순서 변경" title="끌어서 이동"><span aria-hidden="true">⠿</span></button>
      <button class="tree-toggle" type="button" data-action="toggle-branch" aria-label="${escapeHtml(node.title)} 하위 항목 접기" aria-expanded="true" ${children.length ? "" : "disabled"}><span aria-hidden="true">⌄</span></button>
      <span class="structure-row__kind">${kindLabel}</span>
      <a class="structure-row__title" href="${node.kind === "folder" ? `#/folder/${encodeURIComponent(node.id)}` : `#/page/${encodeURIComponent(node.id)}`}"><span class="tree-symbol tree-symbol--${node.kind}" aria-hidden="true"></span><span>${escapeHtml(node.title)}</span></a>
      <span class="status-chip status-chip--${escapeHtml(node.status)}">${statusLabel(node.status)}</span>
      <time datetime="${escapeHtml(node.updatedAt || "")}">${relativeTime(node.updatedAt)}</time>
      <div class="structure-row__move" aria-label="${escapeHtml(node.title)} 이동">
        <button type="button" data-action="move-node" data-direction="up" data-node-id="${escapeHtml(node.id)}" aria-label="위로 이동">↑</button>
        <button type="button" data-action="move-node" data-direction="down" data-node-id="${escapeHtml(node.id)}" aria-label="아래로 이동">↓</button>
        <button type="button" data-action="move-node" data-direction="indent" data-node-id="${escapeHtml(node.id)}" aria-label="안쪽으로 이동">→</button>
        <button type="button" data-action="move-node" data-direction="outdent" data-node-id="${escapeHtml(node.id)}" aria-label="바깥쪽으로 이동">←</button>
      </div>
      <a class="structure-row__edit" href="${node.kind === "page" ? `#/edit/${encodeURIComponent(node.id)}` : `#/folder/${encodeURIComponent(node.id)}`}" aria-label="${escapeHtml(node.title)} ${node.kind === "page" ? "편집" : "열기"}">${node.kind === "page" ? "편집" : "열기"}</a>
    </div>
    ${children.length ? `<ol class="structure-children">${children.map((child) => renderStructureNode(child, nodes, depth + 1)).join("")}</ol>` : ""}
  </li>`;
}

function renderStructure(state) {
  const roots = nodeChildren(state.nodes, null);
  return `<div class="page page--structure">
    <header class="page-heading page-heading--split"><div><span class="eyebrow">ARCHIVE TOPOLOGY</span><h1>기록 구조 관리</h1><p>데스크톱에서는 끌어서, 모바일에서는 화살표 버튼으로 폴더와 문서의 순서를 정리하세요.</p></div><div class="button-row"><button class="button button--secondary" type="button" data-action="open-create" data-kind="folder">＋ 폴더</button><button class="button button--primary" type="button" data-action="open-create" data-kind="page">＋ 문서</button></div></header>
    <div class="structure-legend"><span><i class="tree-symbol tree-symbol--folder" aria-hidden="true"></i> 폴더</span><span><i class="tree-symbol tree-symbol--page" aria-hidden="true"></i> 문서</span><span><i class="status-light status-light--draft" aria-hidden="true"></i> 초안</span><small>끌기 또는 ↑ ↓ → ← 버튼으로 이동</small></div>
    <section class="structure-panel" aria-labelledby="structure-list-title">
      <header><div><span class="eyebrow">LIVE HIERARCHY</span><h2 id="structure-list-title">전체 구조</h2></div><span class="save-status save-status--${escapeHtml(state.structureSaveState)}" role="status"><i aria-hidden="true"></i>${escapeHtml(state.structureSaveLabel)}</span></header>
      ${roots.length ? `<ol class="structure-tree" data-structure-tree>${roots.map((node) => renderStructureNode(node, state.nodes)).join("")}</ol>` : `<div class="empty-panel"><span class="empty-panel__signal" aria-hidden="true"></span><h3>정리할 기록이 없습니다</h3><p>첫 번째 폴더를 만든 뒤 이곳에서 구조를 관리할 수 있습니다.</p><button class="button button--primary" type="button" data-action="open-create" data-kind="folder">첫 폴더 만들기</button></div>`}
    </section>
  </div>`;
}

function renderFormatToolbar(blockId) {
  return `<div class="format-toolbar" role="toolbar" aria-label="텍스트 서식" data-toolbar-for="${escapeHtml(blockId)}">
    <select data-format="fontName" aria-label="글꼴"><option value="system-ui">기본 고딕</option><option value="Georgia">명조</option><option value="Cascadia Mono">고정폭</option></select>
    <select data-format="fontSize" aria-label="글자 크기"><option value="2">작게</option><option value="3" selected>본문</option><option value="4">크게</option><option value="5">제목</option></select>
    <span class="toolbar-group">
      <button type="button" data-command="bold" aria-label="굵게"><strong>B</strong></button><button type="button" data-command="italic" aria-label="기울임"><em>I</em></button><button type="button" data-command="underline" aria-label="밑줄"><u>U</u></button><button type="button" data-command="strikeThrough" aria-label="취소선"><s>S</s></button>
    </span>
    <span class="toolbar-group toolbar-colors"><label title="글자색"><span>A</span><input type="color" value="#edf5ff" data-format="foreColor" aria-label="글자색" /></label><label title="배경색"><span>▰</span><input type="color" value="#243044" data-format="hiliteColor" aria-label="글자 배경색" /></label></span>
    <span class="toolbar-group"><button type="button" data-command="justifyLeft" aria-label="왼쪽 정렬">≡</button><button type="button" data-command="justifyCenter" aria-label="가운데 정렬">≣</button><button type="button" data-command="justifyRight" aria-label="오른쪽 정렬">≡</button></span>
    <span class="toolbar-group"><button type="button" data-command="insertUnorderedList" aria-label="글머리 목록">•≡</button><button type="button" data-command="insertOrderedList" aria-label="번호 목록">1≡</button></span>
    <button type="button" data-command="removeFormat" aria-label="서식 지우기">Tx</button>
  </div>`;
}

function renderBlockActions(block, index, total) {
  return `<div class="editor-block__rail">
    <button class="block-drag" type="button" data-block-drag aria-label="블록 끌어서 이동" title="끌어서 이동">⠿</button>
    <span>${String(index + 1).padStart(2, "0")}</span>
    <div class="block-mobile-move"><button type="button" data-action="move-block" data-direction="up" data-block-id="${escapeHtml(block.id)}" ${index === 0 ? "disabled" : ""} aria-label="블록 위로 이동">↑</button><button type="button" data-action="move-block" data-direction="down" data-block-id="${escapeHtml(block.id)}" ${index === total - 1 ? "disabled" : ""} aria-label="블록 아래로 이동">↓</button></div>
    <button class="block-remove" type="button" data-action="remove-block" data-block-id="${escapeHtml(block.id)}" aria-label="블록 삭제">×</button>
  </div>`;
}

function renderEditorBlock(block, index, total, state) {
  const data = block.data || {};
  const rawType = block.blockType || block.type || "text";
  const type = rawType === "rich_text" ? "text" : rawType === "google_sheet" ? "sheet" : rawType;
  let body = "";
  if (type === "text") {
    body = `${renderFormatToolbar(block.id)}<div class="editable-rich rich-content" contenteditable="true" role="textbox" aria-multiline="true" data-block-field="html" data-placeholder="내용을 입력하거나 /를 눌러 블록을 추가하세요">${sanitizeUserHtml(data.html || "<p><br></p>")}</div>`;
  } else if (type === "image") {
    body = `<div class="image-editor" data-asset-id="${escapeHtml(data.assetId || "")}"><div class="image-editor__preview">${data.previewUrl ? `<img src="${escapeHtml(data.previewUrl)}" alt="${escapeHtml(data.alt || "")}" />` : `<span class="css-icon css-icon--image" aria-hidden="true"></span><strong>${data.assetId ? "이미지 불러오는 중…" : "이미지를 선택하세요"}</strong><small>PNG, JPG, WEBP · 기기 내부에 저장</small>`}</div><label class="button button--secondary file-button">${data.assetId ? "이미지 교체" : "이미지 선택"}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-image-upload data-block-id="${escapeHtml(block.id)}" /></label><div class="field-row"><label>대체 텍스트<input type="text" data-block-field="alt" value="${escapeHtml(data.alt || "")}" placeholder="이미지의 내용을 설명하세요" /></label><label>캡션<input type="text" data-block-field="caption" value="${escapeHtml(data.caption || "")}" placeholder="선택 사항" /></label></div></div>`;
  } else if (type === "youtube") {
    const id = youtubeId(data.url || "");
    body = `<div class="embed-editor"><div class="embed-editor__badge">YT</div><div class="field-grid"><label>영상 URL<input type="url" data-block-field="url" value="${escapeHtml(data.url || "")}" placeholder="https://youtu.be/…" inputmode="url" /></label><label>표시 제목<input type="text" data-block-field="title" value="${escapeHtml(data.title || "")}" placeholder="영상 제목" /></label><label class="field-grid__wide">캡션<input type="text" data-block-field="caption" value="${escapeHtml(data.caption || "")}" placeholder="선택 사항" /></label></div>${id ? `<div class="embed-editor__valid"><i aria-hidden="true"></i> 영상 ID ${escapeHtml(id)} 감지됨 · 오프라인에서는 링크만 보관됩니다.</div>` : `<div class="embed-editor__hint">YouTube 공유 링크를 붙여 넣으세요.</div>`}</div>`;
  } else if (type === "sheet") {
    body = `<div class="sheet-editor"><span class="sheet-block__icon" aria-hidden="true">▦</span><div class="field-grid"><label>Google Sheets 링크<input type="url" data-block-field="url" value="${escapeHtml(data.url || "")}" placeholder="https://docs.google.com/spreadsheets/…" inputmode="url" /></label><label>시트 제목<input type="text" data-block-field="title" value="${escapeHtml(data.title || "")}" placeholder="밸런스 테이블" /></label><label class="field-grid__wide">표시 범위<input type="text" data-block-field="range" value="${escapeHtml(data.range || "")}" placeholder="예: WeaponData!A1:H24" /></label></div><p>링크와 범위는 오프라인에도 남으며 실제 시트 내용은 인터넷 연결 시 열립니다.</p></div>`;
  } else if (type === "callout") {
    body = `<div class="callout-editor"><label>유형<select data-block-field="tone"><option value="info" ${data.tone === "info" ? "selected" : ""}>정보</option><option value="warning" ${data.tone === "warning" ? "selected" : ""}>주의</option><option value="danger" ${data.tone === "danger" ? "selected" : ""}>위험</option><option value="success" ${data.tone === "success" ? "selected" : ""}>완료</option></select></label><label>제목<input type="text" data-block-field="title" value="${escapeHtml(data.title || "")}" placeholder="참고" /></label><label class="callout-editor__text">내용<textarea rows="3" data-block-field="text" placeholder="강조할 내용을 입력하세요">${escapeHtml(data.text || "")}</textarea></label></div>`;
  } else if (type === "divider") {
    body = `<div class="divider-editor"><span></span><i></i><span></span><small>구분선</small></div>`;
  }
  return `<section class="editor-block editor-block--${escapeHtml(type)}" data-editor-block data-block-id="${escapeHtml(block.id)}" data-block-type="${escapeHtml(type)}" draggable="true">${renderBlockActions(block, index, total)}<div class="editor-block__content">${body}</div></section>`;
}

function renderEditor(state) {
  const node = state.activeNode;
  if (!node) return renderNotFound();
  const blocks = state.editorBlocks || [];
  const parents = sortByOrder(state.nodes.filter((item) => item.kind === "folder" && !item.deletedAt));
  return `<div class="editor-screen" data-editor-root data-node-id="${escapeHtml(node.id)}">
    <header class="editor-topbar">
      <div class="editor-topbar__identity"><a class="icon-button icon-button--bordered" href="#/page/${encodeURIComponent(node.id)}" aria-label="편집기 닫기"><span aria-hidden="true">←</span></a><div><span class="eyebrow">DOCUMENT EDITOR</span><strong>${escapeHtml(node.title || "새 기록")}</strong></div></div>
      <div class="editor-topbar__actions"><span class="save-status save-status--${escapeHtml(state.editorSaveState)}" role="status" aria-live="polite"><i aria-hidden="true"></i>${escapeHtml(state.editorSaveLabel)}</span><button class="button button--secondary" type="button" data-action="save-draft">초안 저장</button><button class="button button--primary" type="button" data-action="publish-page">게시하기</button><button class="icon-button editor-more" type="button" data-action="toggle-inspector" aria-label="문서 설정 열기"><span class="css-icon css-icon--settings" aria-hidden="true"></span></button></div>
    </header>
    <div class="editor-layout">
      <main class="editor-canvas" id="editor-canvas">
        <article class="editor-document" aria-label="문서 편집">
          <div class="editor-document__status"><span class="status-chip status-chip--${escapeHtml(node.status)}">${statusLabel(node.status)}</span><span>${state.unsyncedCount} LOCAL CHANGES</span></div>
          <label class="sr-only" for="editor-title">문서 제목</label><input class="editor-title" id="editor-title" name="title" value="${escapeHtml(node.title || "")}" maxlength="180" placeholder="기록 제목" />
          <label class="sr-only" for="editor-summary">문서 요약</label><textarea class="editor-summary" id="editor-summary" name="summary" rows="2" maxlength="500" placeholder="이 기록을 한 문장으로 설명하세요">${escapeHtml(node.summary || "")}</textarea>
          <div class="editor-divider" aria-hidden="true"><span></span><i></i></div>
          <div class="editor-block-list" data-editor-block-list aria-label="콘텐츠 블록">${blocks.map((block, index) => renderEditorBlock(block, index, blocks.length, state)).join("")}</div>
          <div class="block-inserter"><span aria-hidden="true"></span><div><small>블록 추가</small><button type="button" data-action="add-block" data-block-type="text"><i aria-hidden="true">T</i>텍스트</button><button type="button" data-action="add-block" data-block-type="image"><i aria-hidden="true">▧</i>이미지</button><button type="button" data-action="add-block" data-block-type="youtube"><i aria-hidden="true">▶</i>YouTube</button><button type="button" data-action="add-block" data-block-type="sheet"><i aria-hidden="true">▦</i>Sheets</button><button type="button" data-action="add-block" data-block-type="callout"><i aria-hidden="true">!</i>강조</button><button type="button" data-action="add-block" data-block-type="divider"><i aria-hidden="true">—</i>구분선</button></div></div>
        </article>
      </main>
      <aside class="editor-inspector ${state.inspectorOpen ? "is-open" : ""}" aria-label="문서 설정">
        <div class="inspector-mobile-head"><span>문서 설정</span><button class="icon-button" type="button" data-action="toggle-inspector" aria-label="설정 닫기"><span class="css-icon css-icon--close" aria-hidden="true"></span></button></div>
        <section class="inspector-section"><header><span class="eyebrow">DOCUMENT DATA</span><h2>기록 설정</h2></header><label>상위 주제<select id="editor-parent"><option value="">최상위</option>${parents.map((parent) => `<option value="${escapeHtml(parent.id)}" ${parent.id === node.parentId ? "selected" : ""}>${escapeHtml(parent.title)}</option>`).join("")}</select></label><label>태그 <span>쉼표로 구분</span><input id="editor-tags" value="${escapeHtml((node.tags || []).join(", "))}" placeholder="무기, 밸런스, 프로토타입" /></label><label>상태<select id="editor-status"><option value="draft" ${node.status === "draft" ? "selected" : ""}>초안</option><option value="published" ${node.status === "published" ? "selected" : ""}>게시됨</option></select></label></section>
        <section class="inspector-section"><header><span class="eyebrow">REVISION LOG</span><h2>변경 기록</h2></header><label>저장 메모<input id="editor-reason" value="" placeholder="예: 밸런스 수치 갱신" /></label><a class="button button--quiet button--full" href="#/revisions/${encodeURIComponent(node.id)}">이전 버전 보기 →</a></section>
        <section class="inspector-section inspector-section--danger"><header><span class="eyebrow">QUARANTINE</span><h2>위험 구역</h2></header><p>문서는 휴지통에서 다시 복원할 수 있습니다.</p><button class="button button--danger button--full" type="button" data-action="trash-node" data-node-id="${escapeHtml(node.id)}">휴지통으로 이동</button></section>
      </aside>
    </div>
  </div>`;
}

function renderTrash(state) {
  const deleted = state.deletedNodes || [];
  return `<div class="page page--trash">
    <header class="page-heading page-heading--split"><div><span class="eyebrow">QUARANTINE STORAGE</span><h1>휴지통</h1><p>삭제한 폴더와 문서는 모든 기기에서 동기화되지만, 언제든 다시 복원할 수 있습니다.</p></div><span class="quarantine-count"><strong>${deleted.length}</strong><small>DELETED RECORDS</small></span></header>
    <div class="notice-panel"><span class="notice-panel__mark" aria-hidden="true">i</span><p><strong>삭제도 동기화 대상입니다.</strong><span>밖에서 삭제한 기록은 PC와 연결될 때 다른 기기에서도 휴지통으로 이동합니다.</span></p></div>
    <section class="trash-panel" aria-labelledby="trash-list-title"><header><div><span class="eyebrow">RECOVERABLE ITEMS</span><h2 id="trash-list-title">복원 가능한 기록</h2></div><span>${state.unsyncedCount}개 변경 대기</span></header>
      ${deleted.length ? `<div class="trash-list">${deleted.map((node) => `<article class="trash-row"><span class="tree-symbol tree-symbol--${escapeHtml(node.kind)}" aria-hidden="true"></span><div><span>${node.kind === "folder" ? "FOLDER" : "PAGE"}</span><h3>${escapeHtml(node.title)}</h3><p>${escapeHtml(node.summary || "요약 없음")}</p></div><time datetime="${escapeHtml(node.deletedAt || "")}">삭제 ${formatDate(node.deletedAt, true)}</time><button class="button button--secondary" type="button" data-action="restore-node" data-node-id="${escapeHtml(node.id)}">복원</button></article>`).join("")}</div>` : `<div class="empty-panel"><span class="quarantine-empty" aria-hidden="true"><i></i></span><h3>휴지통이 비어 있습니다</h3><p>격리된 기록이 없습니다. 모든 활성 문서는 아카이브에 안전하게 보관되어 있습니다.</p><a class="button button--secondary" href="#/home">아카이브로 돌아가기</a></div>`}
    </section>
  </div>`;
}

function renderRevisions(state) {
  const node = state.activeNode;
  if (!node) return renderNotFound();
  const revisions = state.revisions || [];
  return `<div class="page page--revisions">
    <nav class="breadcrumbs" aria-label="현재 위치"><a href="#/page/${encodeURIComponent(node.id)}">${escapeHtml(node.title)}</a><span>/</span><span aria-current="page">변경 이력</span></nav>
    <header class="page-heading page-heading--split"><div><span class="eyebrow">REVISION TELEMETRY</span><h1>변경 이력</h1><p>기기에서 저장된 문서 스냅샷을 시간순으로 확인합니다.</p></div><a class="button button--primary" href="#/edit/${encodeURIComponent(node.id)}">현재 문서 편집</a></header>
    <section class="revision-layout"><div class="revision-current"><span class="revision-current__pulse" aria-hidden="true"></span><div><span>CURRENT VERSION</span><h2>${escapeHtml(node.title)}</h2><p>${escapeHtml(node.summary || "요약 없음")}</p><small>마지막 수정 ${formatDate(node.updatedAt, true)}</small></div><span class="status-chip status-chip--${escapeHtml(node.status)}">${statusLabel(node.status)}</span></div>
      <ol class="revision-list">${revisions.length ? revisions.map((revision, index) => `<li><span class="revision-list__line" aria-hidden="true"><i></i></span><article><header><div><span>REV ${escapeHtml(revision.number || revisions.length - index)}</span><strong>${escapeHtml(revision.reason || revision.changeNote || "자동 저장")}</strong></div><time datetime="${escapeHtml(revision.createdAt || "")}">${formatDate(revision.createdAt, true)}</time></header><p>${escapeHtml(revision.summary || revision.node?.summary || "문서 내용과 메타데이터 스냅샷")}</p><footer><span>${escapeHtml(revision.deviceName || "LOCAL DEVICE")}</span><button class="text-button" type="button" data-action="preview-revision" data-revision-id="${escapeHtml(revision.id)}">미리보기</button>${revision.blocks || revision.snapshot ? `<button class="text-button" type="button" data-action="restore-revision" data-revision-id="${escapeHtml(revision.id)}">이 버전을 초안으로 복원</button>` : ""}</footer></article></li>`).join("") : `<li class="revision-empty"><span class="revision-list__line" aria-hidden="true"><i></i></span><div><strong>아직 저장된 이전 버전이 없습니다</strong><p>초안을 저장하거나 게시하면 이곳에 스냅샷이 남습니다.</p></div></li>`}</ol>
    </section>
  </div>`;
}

function platformCopy(platform) {
  if (platform.kind === "desktop") return { eyebrow: "WINDOWS ARCHIVE NODE", title: "이 PC가 기준 아카이브입니다", body: "휴대폰이 같은 개인망에 들어오면 대기 중인 변경을 받아 백업합니다.", field: "이 PC의 동기화 주소" };
  if (platform.kind === "android") return { eyebrow: "ANDROID FIELD NODE", title: "밖에서 만든 기록을 보관 중입니다", body: "집에 도착해 PC가 켜지면 동기화 버튼을 눌러 변경을 합치세요.", field: "집 PC의 동기화 주소" };
  return { eyebrow: "WEB ARCHIVE NODE", title: "브라우저 안에 로컬 사본이 있습니다", body: "브라우저 데이터를 지우기 전에 백업을 내보내고, 지원되는 경우 앱으로 설치하세요.", field: "집 PC의 동기화 주소" };
}

function renderSyncState(state) {
  const sync = state.syncStatus;
  const labels = {
    idle: "연결 대기",
    connecting: "PC 찾는 중",
    active: sync.direction === "push" ? "PC로 보내는 중" : sync.direction === "pull" ? "PC에서 받는 중" : "동기화 중",
    paused: "일시 정지",
    error: "연결 오류",
    stopped: "연결 중지",
  };
  return labels[sync.state] || "연결 대기";
}

function renderConflict(conflict) {
  const title = conflict.title || conflict.local?.title || conflict.remote?.title || "이름 없는 충돌";
  return `<article class="conflict-card" data-conflict-id="${escapeHtml(conflict.id)}"><header><span class="conflict-card__mark" aria-hidden="true">!</span><div><span>EDIT COLLISION</span><h3>${escapeHtml(title)}</h3></div><time>${formatDate(conflict.updatedAt || conflict.detectedAt, true)}</time></header><div class="conflict-versions"><div><span>이 기기 버전</span><p>${escapeHtml(conflict.local?.summary || conflict.localPreview || "로컬 변경 내용")}</p><small>${formatDate(conflict.local?.updatedAt, true)}</small></div><div><span>PC 버전</span><p>${escapeHtml(conflict.remote?.summary || conflict.remotePreview || "원격 변경 내용")}</p><small>${formatDate(conflict.remote?.updatedAt, true)}</small></div></div><footer><button class="button button--secondary" type="button" data-action="resolve-conflict" data-winner="local" data-conflict-id="${escapeHtml(conflict.id)}">이 기기 사용</button><button class="button button--secondary" type="button" data-action="resolve-conflict" data-winner="remote" data-conflict-id="${escapeHtml(conflict.id)}">PC 버전 사용</button><button class="button button--primary" type="button" data-action="resolve-conflict" data-winner="merge" data-conflict-id="${escapeHtml(conflict.id)}">두 버전 모두 보관</button></footer></article>`;
}

function renderDesktopRuntime(state) {
  if (state.platform.kind !== "desktop") return "";
  const runtime = state.runtimeInfo || {};
  const publicUrl = runtime.tailscaleUrl || runtime.localUrl || "PC 앱을 다시 시작해 주소를 확인하세요";
  return `<section class="runtime-card" aria-labelledby="runtime-title"><header><div><span class="eyebrow">PC SYNC HOST</span><h2 id="runtime-title">휴대폰 연결 정보</h2><p>아래 세 값을 Android 앱의 PC 연결 항목에 그대로 입력하세요.</p></div><span class="status-chip status-chip--${runtime.localUrl ? "published" : "draft"}">${runtime.localUrl ? "서버 실행 중" : "확인 중"}</span></header><div class="credential-grid"><label>동기화 URL<div><input id="runtime-url" readonly value="${escapeHtml(publicUrl)}" /><button type="button" data-action="copy-field" data-copy-target="runtime-url">복사</button></div></label><label>사용자명<div><input id="runtime-username" readonly value="${escapeHtml(runtime.username || "wiki-sync")}" /><button type="button" data-action="copy-field" data-copy-target="runtime-username">복사</button></div></label><label>비밀번호<div><input id="runtime-password" readonly type="password" value="${escapeHtml(runtime.password || "")}" autocomplete="off" /><button type="button" data-action="toggle-secret" data-secret-target="runtime-password">보기</button><button type="button" data-action="copy-field" data-copy-target="runtime-password">복사</button></div></label></div><label class="toggle-row runtime-card__autostart"><span><strong>Windows 로그인 시 자동 시작</strong><small>창은 숨기고 트레이에서 동기화 호스트를 준비합니다.</small></span><input type="checkbox" data-desktop-autostart ${runtime.autoStart ? "checked" : ""} /><i aria-hidden="true"></i></label><footer><div><strong>${runtime.tailscaleUrl ? "Tailscale 주소 사용 가능" : "외부 접속 주소가 아직 없습니다"}</strong><small>${runtime.tailscaleUrl ? escapeHtml(runtime.tailscaleUrl) : "Tailscale을 연결하면 집 밖에서도 개인망으로 동기화할 수 있습니다."}</small></div>${runtime.tailscaleUrl ? "" : `<button class="button button--secondary" type="button" data-action="configure-tailscale">Tailscale 연결 설정</button>`}<button class="button button--secondary" type="button" data-action="create-desktop-backup">지금 PC 백업</button><button class="text-button" type="button" data-action="open-backup-folder">백업 폴더 열기</button></footer></section>`;
}

function renderSettings(state) {
  const copy = platformCopy(state.platform);
  const syncLabel = renderSyncState(state);
  const conflicts = state.conflicts || [];
  return `<div class="page page--settings">
    <header class="page-heading page-heading--split"><div><span class="eyebrow">DEVICE &amp; SYNCHRONIZATION</span><h1>설정 및 동기화</h1><p>이 기기의 로컬 사본, 집 PC 연결과 백업을 관리합니다.</p></div><span class="device-badge"><i class="device-icon device-icon--${escapeHtml(state.platform.kind)}" aria-hidden="true"></i><span>${escapeHtml(state.platform.label)}<small>${state.platform.isNative ? "INSTALLED APP" : "WEB APP"}</small></span></span></header>

    <section class="sync-overview" aria-labelledby="sync-overview-title">
      <div class="sync-radar sync-radar--${escapeHtml(state.syncTone)}" aria-hidden="true"><span></span><i></i><b>${state.unsyncedCount}</b></div>
      <div><span class="eyebrow">${copy.eyebrow}</span><h2 id="sync-overview-title">${copy.title}</h2><p>${copy.body}</p><div class="sync-overview__status"><span class="sync-orb sync-orb--${escapeHtml(state.syncTone)}" aria-hidden="true"></span><strong>${syncLabel}</strong><small>마지막 동기화 ${relativeTime(state.syncStatus.lastSyncedAt)}</small></div></div>
      <div class="sync-overview__actions"><button class="button button--primary" type="button" data-action="sync-now" ${!state.online ? "disabled" : ""}>지금 동기화</button><button class="button button--secondary" type="button" data-action="toggle-sync">${state.syncStatus.running ? "동기화 일시 정지" : "연결 시작"}</button></div>
    </section>

    ${renderDesktopRuntime(state)}

    <div class="settings-grid">
      <section class="settings-panel" aria-labelledby="device-settings-title"><header><div><span class="eyebrow">PAIRING LINK</span><h2 id="device-settings-title">PC 연결</h2></div><span class="status-chip status-chip--${state.settings.remoteUrl ? "published" : "draft"}">${state.settings.remoteUrl ? "설정됨" : "미설정"}</span></header>
        <form data-pairing-form><label>${copy.field}<input type="url" name="remoteUrl" value="${escapeHtml(state.settings.remoteUrl || "")}" placeholder="https://your-pc.tailnet.ts.net" inputmode="url" autocapitalize="off" spellcheck="false" /></label><div class="field-row"><label>사용자명<input name="username" value="${escapeHtml(state.settings.username || "wiki-sync")}" autocomplete="username" autocapitalize="off" /></label><label>비밀번호<span class="secret-field"><input id="sync-password" name="password" type="password" value="${escapeHtml(state.settings.password || "")}" autocomplete="current-password" /><button type="button" data-action="toggle-secret" data-secret-target="sync-password">보기</button></span></label></div><label>이 기기 이름<input name="deviceName" value="${escapeHtml(state.settings.deviceName || state.platform.defaultDeviceName)}" maxlength="40" /></label><label class="toggle-row"><span><strong>연결 가능할 때 자동 동기화</strong><small>앱을 열었을 때 집 PC를 자동으로 찾습니다.</small></span><input type="checkbox" name="autoSync" ${state.settings.autoSync ? "checked" : ""} /><i aria-hidden="true"></i></label><button class="button button--secondary button--full" type="submit">연결 설정 저장</button></form>
        <div class="pairing-help"><span aria-hidden="true">01</span><p>PC와 휴대폰을 Tailscale 같은 개인망에 연결합니다.</p><span aria-hidden="true">02</span><p>PC 앱에 표시된 주소와 페어링 코드를 입력합니다.</p><span aria-hidden="true">03</span><p>두 앱에서 동기화를 눌러 최초 사본을 맞춥니다.</p></div>
      </section>

      <section class="settings-panel" aria-labelledby="storage-title"><header><div><span class="eyebrow">LOCAL STORAGE</span><h2 id="storage-title">기기 저장소</h2></div><span>${escapeHtml(state.storageEstimate.label)}</span></header><div class="storage-meter" role="meter" aria-label="저장 공간 사용량" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${state.storageEstimate.percent}"><span style="width:${state.storageEstimate.percent}%"></span></div><dl class="storage-stats"><div><dt>문서</dt><dd>${state.activeCount}</dd></div><div><dt>이미지</dt><dd>${state.assetCount ?? "—"}</dd></div><div><dt>예상 사용량</dt><dd>${escapeHtml(state.storageEstimate.used)}</dd></div></dl><p class="settings-note"><i aria-hidden="true">i</i> 데이터는 서버가 아니라 이 기기의 앱 저장소에 우선 보관됩니다.</p>
        <div class="button-stack"><button class="button button--secondary button--full" type="button" data-action="export-data">백업 파일 내보내기</button><button class="button button--quiet button--full" type="button" data-action="open-import">백업 파일 가져오기</button><input class="sr-only" id="import-file" type="file" accept="application/json,application/gzip,.json,.gz" data-import-file /><label class="import-strategy" for="import-strategy">가져오기 방식<select id="import-strategy"><option value="merge">현재 기록과 합치기</option><option value="replace">현재 기록 교체</option></select></label></div>
      </section>
    </div>

    <section class="conflict-center" aria-labelledby="conflict-title"><header><div><span class="eyebrow">CONFLICT CENTER</span><h2 id="conflict-title">동기화 충돌</h2><p>같은 기록을 PC와 휴대폰에서 각각 수정했을 때만 선택이 필요합니다.</p></div><span class="conflict-count ${conflicts.length ? "has-conflicts" : ""}">${conflicts.length}<small>NEEDS REVIEW</small></span></header>${conflicts.length ? `<div class="conflict-list">${conflicts.map(renderConflict).join("")}</div>` : `<div class="conflict-empty"><span class="conflict-empty__mark" aria-hidden="true">✓</span><div><strong>검토할 충돌이 없습니다</strong><p>서로 다른 문서의 변경은 자동으로 합쳐집니다.</p></div></div>`}</section>

    <section class="settings-footer-grid">
      <div><span class="eyebrow">OFFLINE POLICY</span><h3>연결 없이도 계속 작성</h3><p>네트워크가 끊겨도 자동 저장은 멈추지 않습니다. 상단의 대기 개수로 아직 PC에 전달되지 않은 변경을 확인하세요.</p></div>
      <div><span class="eyebrow">APP MODE</span><h3>${state.platform.isNative ? "설치된 앱으로 실행 중" : "브라우저 모드"}</h3><p>${state.platform.isNative ? "앱 셸이 업데이트와 로컬 파일 접근을 관리합니다." : "설치 가능한 브라우저에서는 홈 화면 앱으로 추가할 수 있습니다."}</p>${!state.platform.isNative && state.installAvailable ? `<button class="text-button" type="button" data-action="install-app">이 기기에 설치 →</button>` : ""}</div>
      <div><span class="eyebrow">ARCHIVE ID</span><h3>${escapeHtml(state.settings.archiveId || "LOCAL-PRIMARY")}</h3><p>동기화할 때 이 아카이브 ID가 같은 기기끼리만 기록을 교환합니다.</p></div>
    </section>
  </div>`;
}

function renderNotFound() {
  return `<div class="page not-found"><span class="not-found__code">404 / LOST SIGNAL</span><div class="not-found__visual" aria-hidden="true"><i></i><span></span></div><h1>기록을 찾을 수 없습니다</h1><p>삭제되었거나 이 기기에 아직 동기화되지 않은 문서일 수 있습니다.</p><a class="button button--primary" href="#/home">아카이브로 돌아가기</a></div>`;
}

function renderView(state) {
  if (state.route.name === "folder") return renderFolder(state);
  if (state.route.name === "page") return renderPage(state);
  if (state.route.name === "edit") return renderEditor(state);
  if (state.route.name === "search") return renderSearch(state);
  if (state.route.name === "structure") return renderStructure(state);
  if (state.route.name === "trash") return renderTrash(state);
  if (state.route.name === "revisions") return renderRevisions(state);
  if (state.route.name === "settings") return renderSettings(state);
  if (state.route.name === "not-found") return renderNotFound();
  return renderHome(state);
}

function renderCreateDialog(state) {
  const folders = sortByOrder(state.nodes.filter((node) => node.kind === "folder" && !node.deletedAt));
  return `<dialog class="modal" id="create-dialog" aria-labelledby="create-dialog-title"><form method="dialog" class="modal__surface" data-create-form><header><div><span class="eyebrow">NEW ARCHIVE ENTRY</span><h2 id="create-dialog-title">새 기록 만들기</h2></div><button class="icon-button" type="button" data-action="close-dialog" data-dialog="create-dialog" aria-label="닫기"><span class="css-icon css-icon--close" aria-hidden="true"></span></button></header><div class="kind-picker" role="radiogroup" aria-label="기록 종류"><label><input type="radio" name="kind" value="page" checked /><span class="tree-symbol tree-symbol--page" aria-hidden="true"></span><strong>문서</strong><small>본문 블록을 작성합니다</small></label><label><input type="radio" name="kind" value="folder" /><span class="tree-symbol tree-symbol--folder" aria-hidden="true"></span><strong>폴더</strong><small>기록을 주제별로 묶습니다</small></label></div><label>제목<input name="title" required maxlength="180" placeholder="예: 전투 시스템 개요" autocomplete="off" /></label><label>한 줄 요약<textarea name="summary" rows="2" maxlength="500" placeholder="무엇을 기록하는 문서인지 설명하세요"></textarea></label><label>상위 폴더<select name="parentId"><option value="">최상위</option>${folders.map((folder) => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.title)}</option>`).join("")}</select></label><label class="toggle-row"><span><strong>바로 게시 상태로 만들기</strong><small>꺼 두면 나만 보는 초안으로 시작합니다.</small></span><input type="checkbox" name="published" /><i aria-hidden="true"></i></label><footer><button class="button button--quiet" type="button" data-action="close-dialog" data-dialog="create-dialog">취소</button><button class="button button--primary" type="submit">기록 만들기</button></footer></form></dialog>`;
}

function renderInstallDialog(state) {
  return `<dialog class="modal modal--compact" id="install-dialog" aria-labelledby="install-dialog-title"><div class="modal__surface"><header><div><span class="eyebrow">INSTALL LOCAL ARCHIVE</span><h2 id="install-dialog-title">앱처럼 설치하기</h2></div><button class="icon-button" type="button" data-action="close-dialog" data-dialog="install-dialog" aria-label="닫기"><span class="css-icon css-icon--close" aria-hidden="true"></span></button></header><div class="install-steps"><span>01</span><p><strong>브라우저 메뉴를 엽니다</strong><small>Chrome 또는 Edge의 메뉴에서 설치 항목을 찾으세요.</small></p><span>02</span><p><strong>“앱 설치”를 선택합니다</strong><small>지원되지 않는 브라우저에서는 홈 화면 추가를 선택하세요.</small></p><span>03</span><p><strong>독립된 창에서 실행합니다</strong><small>데이터는 같은 기기 저장소에 유지됩니다.</small></p></div><footer><button class="button button--primary button--full" type="button" data-action="close-dialog" data-dialog="install-dialog">확인</button></footer></div></dialog>`;
}

function renderToast(state) {
  if (!state.toast) return "";
  return `<div class="toast toast--${escapeHtml(state.toast.tone || "info")}" role="status"><span aria-hidden="true"></span><p>${escapeHtml(state.toast.message)}</p><button type="button" data-action="dismiss-toast" aria-label="알림 닫기">×</button></div>`;
}

export function renderApp(state) {
  const editorMode = state.route.name === "edit";
  return `${renderOfflineBanner(state)}${editorMode ? "" : renderTopbar(state)}<div class="drawer-backdrop ${state.drawerOpen ? "is-visible" : ""}" data-action="close-drawer" aria-hidden="true"></div><div class="app-shell ${editorMode ? "app-shell--editor" : ""}">${editorMode ? "" : renderSidebar(state)}<main class="main-content" id="main-content" tabindex="-1">${renderView(state)}</main></div>${editorMode ? "" : renderMobileNav(state)}${renderInstallBanner(state)}${renderCreateDialog(state)}${renderInstallDialog(state)}${renderToast(state)}`;
}
