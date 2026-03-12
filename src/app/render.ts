import type {
  AssistantCitation,
  DocumentCard,
  DocumentSection,
  DocumentView,
  FeedTab,
  RailPanel,
  SearchArchitectureStep,
  SearchResponse,
} from "./data";

export interface Viewer {
  id: string;
  name: string;
  handle: string;
  email: string;
  bio: string;
  interests: string[];
  onboardingComplete: boolean;
  avatarUrl?: string;
}

export interface LibraryCollection {
  id: string;
  name: string;
  docIds: string[];
  createdAt: string;
}

export interface NoteRecord {
  id: string;
  docId: string;
  anchor: string;
  text: string;
  createdAt: string;
}

export interface CommentRecord {
  id: string;
  docId: string;
  userId: string;
  userName: string;
  handle: string;
  text: string;
  createdAt: string;
}

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations?: AssistantCitation[];
  jobId?: string;
  mode?: "fast" | "agent";
  status?: "pending" | "completed" | "failed";
}

export interface AssistantThread {
  id: string;
  title: string;
  docId?: string;
  createdAt: string;
  updatedAt: string;
  messages: AssistantMessage[];
}

const appCss = `
:root {
  --bg: #f4f0e8;
  --panel: #ebe5d9;
  --panel-strong: #e1d8c8;
  --paper: #fbf8f2;
  --paper-strong: #fffdf8;
  --ink: #171717;
  --muted: #6a655d;
  --line: rgba(23, 23, 23, 0.12);
  --line-strong: rgba(23, 23, 23, 0.2);
  --accent: #1f4b74;
  --accent-soft: rgba(31, 75, 116, 0.09);
  --accent-warm: #9e3f4b;
  --accent-warm-soft: rgba(158, 63, 75, 0.1);
  --danger: #8a302f;
  --success: #1d5d3e;
  --shadow: 0 20px 60px rgba(54, 45, 30, 0.08);
  --radius: 22px;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  background:
    radial-gradient(circle at top left, rgba(255, 255, 255, 0.55), transparent 32%),
    linear-gradient(180deg, #f7f3ec 0%, var(--bg) 100%);
  color: var(--ink);
  font-family: "Avenir Next", "Optima", "Segoe UI", sans-serif;
}

body {
  line-height: 1.5;
}

a {
  color: inherit;
  text-decoration: none;
}

button,
input,
textarea,
select {
  font: inherit;
}

.shell {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  padding: 22px 18px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.3), transparent 18%),
    var(--panel);
  border-right: 1px solid var(--line);
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  gap: 20px;
}

.brand {
  display: grid;
  justify-items: center;
  gap: 10px;
}

.brand-mark {
  width: 52px;
  height: 52px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  background: var(--paper);
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: 1.35rem;
  letter-spacing: -0.06em;
}

.brand-word {
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: 1.1rem;
  letter-spacing: -0.04em;
}

.sidebar-nav {
  display: grid;
  gap: 8px;
}

.sidebar-nav a {
  padding: 12px 10px;
  border-radius: 18px;
  text-align: center;
  color: var(--muted);
  border: 1px solid transparent;
}

.sidebar-nav a.active {
  color: var(--ink);
  background: rgba(255, 255, 255, 0.68);
  border-color: var(--line);
  box-shadow: var(--shadow);
}

.sidebar-spacer {
  min-height: 16px;
}

.sidebar-footer {
  display: grid;
  justify-items: center;
}

.avatar-link,
.avatar,
.avatar-large {
  border-radius: 50%;
  overflow: hidden;
}

.avatar-link {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.6);
}

.avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-fallback,
.avatar-fallback-large {
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-warm) 100%);
  color: white;
  font-weight: 600;
}

.avatar-fallback {
  width: 100%;
  height: 100%;
}

.avatar-large {
  width: 120px;
  height: 120px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}

.avatar-fallback-large {
  width: 100%;
  height: 100%;
  font-size: 2.5rem;
}

.main {
  padding: 34px 44px 56px;
}

.page {
  width: min(1180px, 100%);
}

.page-head {
  display: grid;
  gap: 12px;
  margin-bottom: 30px;
}

.page-title,
.doc-title,
.auth-title {
  margin: 0;
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: clamp(2.55rem, 5vw, 4.9rem);
  line-height: 0.94;
  letter-spacing: -0.055em;
}

.section-title {
  margin: 0;
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: 1.55rem;
  line-height: 1;
  letter-spacing: -0.04em;
}

.eyebrow {
  color: var(--muted);
  font-size: 0.74rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.muted,
.meta,
.small {
  color: var(--muted);
}

.small {
  font-size: 0.88rem;
}

.stack {
  display: grid;
  gap: 24px;
}

.section {
  padding-top: 22px;
  border-top: 1px solid var(--line);
}

.section:first-child {
  border-top: none;
  padding-top: 0;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.button,
.button-quiet,
.button-danger,
.icon-button {
  min-height: 44px;
  padding: 0 18px;
  border-radius: 999px;
  border: 1px solid transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: transparent;
}

.button {
  background: var(--ink);
  color: white;
  box-shadow: 0 12px 30px rgba(23, 23, 23, 0.16);
}

.button-quiet,
.icon-button {
  border-color: var(--line);
  background: rgba(255, 255, 255, 0.65);
}

.button-danger {
  border-color: rgba(138, 48, 47, 0.22);
  color: var(--danger);
  background: rgba(138, 48, 47, 0.04);
}

.chip-row,
.chips,
.tab-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.chip,
.tab-row a {
  border-radius: 999px;
  padding: 8px 13px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.62);
  color: var(--muted);
}

.tab-row a.active {
  background: var(--paper-strong);
  color: var(--ink);
  border-color: var(--line-strong);
}

.plain-panel,
.feed-card,
.search-stage,
.prompt-card,
.chat-shell,
.profile-card,
.history-row,
.resource-card,
.auth-box,
.reader-shell,
.assistant-rail {
  background: rgba(255, 255, 255, 0.66);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.search-stage,
.assistant-compose,
.auth-panel,
.line-form {
  display: grid;
  gap: 12px;
}

.search-stage {
  padding: 18px;
}

.search-stage textarea,
.assistant-compose textarea,
.auth-panel textarea,
.auth-panel input,
.line-form input,
.composer select,
.composer input,
.composer textarea {
  width: 100%;
  min-height: 56px;
  padding: 16px 18px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: var(--paper-strong);
  color: var(--ink);
}

.search-stage textarea,
.assistant-compose textarea,
.auth-panel textarea,
.composer textarea {
  min-height: 124px;
  resize: vertical;
}

.flash {
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(138, 48, 47, 0.08);
  color: var(--danger);
}

.explore-hero,
.assistant-hero {
  display: grid;
  gap: 18px;
  margin-bottom: 30px;
}

.assistant-hero {
  justify-items: center;
  text-align: center;
  padding-top: 12px;
}

.signal {
  width: 78px;
  height: 78px;
  border-radius: 26px;
  display: grid;
  place-items: center;
  background: var(--accent-warm-soft);
  color: var(--accent-warm);
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: 2.3rem;
}

.feed-list,
.search-results,
.history-list,
.thread-list {
  display: grid;
  gap: 18px;
}

.feed-card {
  padding: 26px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 22px;
}

.feed-main {
  display: grid;
  gap: 14px;
}

.feed-title {
  margin: 0;
  font-size: clamp(2rem, 4vw, 3.1rem);
  line-height: 0.96;
  letter-spacing: -0.05em;
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
}

.feed-body {
  font-size: 1.02rem;
  max-width: 58ch;
}

.feed-preview {
  min-height: 240px;
  border-radius: 22px;
  border: 1px solid var(--line);
  background:
    linear-gradient(160deg, rgba(255, 255, 255, 0.76), rgba(255, 255, 255, 0.18)),
    linear-gradient(135deg, rgba(31, 75, 116, 0.14), rgba(158, 63, 75, 0.08));
  padding: 18px;
  display: grid;
  align-content: space-between;
}

.preview-kicker {
  font-size: 0.8rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}

.preview-title {
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: 1.42rem;
  line-height: 1;
  letter-spacing: -0.04em;
}

.preview-foot {
  color: var(--muted);
  font-size: 0.92rem;
}

.search-layout,
.doc-layout,
.library-layout,
.profile-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 30px;
  align-items: start;
}

.reader-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 420px;
  gap: 28px;
  align-items: start;
}

.reader-column {
  display: grid;
  gap: 20px;
}

.reader-shell {
  overflow: hidden;
  background: white;
  min-height: 78vh;
}

.reader-frame {
  width: 100%;
  min-height: 78vh;
  border: 0;
  display: block;
  background: white;
}

.aside,
.profile-aside {
  position: sticky;
  top: 34px;
  display: grid;
  gap: 18px;
}

.assistant-rail {
  padding: 20px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 18px;
  min-height: 78vh;
}

.assistant-rail-head {
  display: grid;
  gap: 6px;
}

.chat-shell {
  padding: 22px;
}

.chat-log {
  display: grid;
  gap: 14px;
}

.message {
  padding: 16px 18px;
  border-radius: 20px;
  background: var(--paper-strong);
  border: 1px solid transparent;
  display: grid;
  gap: 8px;
}

.message.user {
  background: var(--accent-soft);
  border-color: rgba(31, 75, 116, 0.12);
}

.message.assistant {
  border-color: var(--line);
}

.message-status {
  color: var(--muted);
  font-size: 0.92rem;
}

.citation-list {
  display: grid;
  gap: 10px;
}

.citation {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.68);
}

.assistant-compose {
  padding-top: 4px;
}

.prompt-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  width: min(920px, 100%);
}

.prompt-card {
  padding: 22px;
  display: grid;
  gap: 8px;
}

.thread-pill {
  display: inline-flex;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--accent-warm-soft);
  color: var(--accent-warm);
}

.profile-hero {
  display: grid;
  justify-items: center;
  text-align: center;
  gap: 14px;
  padding: 18px 0 10px;
}

.profile-name {
  margin: 0;
  font-size: clamp(2.1rem, 4vw, 3.3rem);
  line-height: 0.96;
  letter-spacing: -0.05em;
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
}

.stat-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}

.stat-cell {
  padding: 14px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid var(--line);
  text-align: center;
}

.profile-tabs {
  display: flex;
  gap: 12px;
  border-top: 1px solid var(--line);
  padding-top: 22px;
}

.profile-tab {
  padding: 10px 18px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.6);
  color: var(--muted);
}

.profile-tab.active {
  color: var(--ink);
  border-color: var(--line-strong);
  background: var(--paper-strong);
}

.history-row {
  padding: 18px;
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.history-preview {
  min-height: 118px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background:
    linear-gradient(160deg, rgba(255, 255, 255, 0.76), rgba(255, 255, 255, 0.2)),
    linear-gradient(135deg, rgba(31, 75, 116, 0.14), rgba(158, 63, 75, 0.08));
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 0.82rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
}

.profile-card {
  padding: 22px;
  display: grid;
  gap: 14px;
}

.form-grid {
  display: grid;
  gap: 12px;
}

.auth-wrap {
  width: min(720px, 100%);
}

.auth-box {
  padding: 24px;
}

.list {
  display: grid;
  gap: 12px;
}

.item,
.note,
.comment,
.thread,
.resource {
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.item:first-child,
.note:first-child,
.comment:first-child,
.thread:first-child,
.resource:first-child {
  padding-top: 0;
  border-top: none;
}

.empty {
  color: var(--muted);
}

.score {
  font-variant-numeric: tabular-nums;
}

.footer-note {
  margin-top: 30px;
  color: var(--muted);
  font-size: 0.9rem;
}

@media (max-width: 1140px) {
  .feed-card,
  .reader-layout,
  .search-layout,
  .doc-layout,
  .library-layout,
  .profile-layout {
    grid-template-columns: 1fr;
  }

  .aside,
  .profile-aside {
    position: static;
    top: auto;
  }

  .assistant-rail {
    min-height: auto;
  }
}

@media (max-width: 840px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    position: static;
    height: auto;
    grid-template-rows: auto auto auto;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }

  .sidebar-nav {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .sidebar-spacer,
  .sidebar-footer {
    display: none;
  }

  .main {
    padding: 24px 20px 42px;
  }

  .prompt-grid,
  .stat-strip {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .feed-card,
  .history-row {
    grid-template-columns: 1fr;
  }

  .reader-shell,
  .reader-frame {
    min-height: 58vh;
  }
}
`;

function e(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function cleanBookTitle(value: string): string {
  return value
    .replace(/\s+\|\s+Project Gutenberg$/i, "")
    .replace(/^The Project Gutenberg eBook of\s+/i, "")
    .trim();
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "A";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function renderAvatar(name: string, avatarUrl: string | undefined, large = false): string {
  const className = large ? "avatar-large" : "avatar-link";
  const fallbackClassName = large ? "avatar-fallback-large" : "avatar-fallback";
  return avatarUrl
    ? `<div class="${className}"><img class="avatar" src="${e(avatarUrl)}" alt="${e(name)}" /></div>`
    : `<div class="${className}"><div class="${fallbackClassName}">${e(initials(name))}</div></div>`;
}

function sidebar(activeNav: string, viewer?: Viewer): string {
  const nav = [
    ["Explore", "/"],
    ["Assistant", "/assistant"],
    ["Library", "/library"],
  ];
  return `
    <aside class="sidebar">
      <a class="brand" href="/">
        <div class="brand-mark">ab</div>
        <div class="brand-word">alphabook</div>
      </a>
      <nav class="sidebar-nav">
        ${nav
          .map(
            ([label, href]) =>
              `<a class="${activeNav === label ? "active" : ""}" href="${href}">${label}</a>`,
          )
          .join("")}
      </nav>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-footer">
        ${
          viewer
            ? `<a href="/u/${e(viewer.handle)}" aria-label="Profile">${renderAvatar(viewer.name, viewer.avatarUrl)}</a>`
            : `<a class="avatar-link" href="/signin" aria-label="Sign in"><div class="avatar-fallback">+</div></a>`
        }
      </div>
    </aside>
  `;
}

function layout(title: string, activeNav: string, viewer: Viewer | undefined, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${e(title)} · alphabook</title>
    <meta name="description" content="Search and research surface for long-form texts." />
    <style>${appCss}</style>
  </head>
  <body>
    <div class="shell">
      ${sidebar(activeNav, viewer)}
      <main class="main">
        <div class="page">${body}</div>
      </main>
    </div>
  </body>
</html>`;
}

function renderLaunchForm(value?: string, error?: string): string {
  return `
    <form class="search-stage" method="post" action="/action/launch">
      <textarea name="query" placeholder="Ask about a book or paste a Gutenberg URL">${e(value ?? "")}</textarea>
      <div class="row">
        <button class="button" type="submit">Open assistant</button>
      </div>
      ${error ? `<div class="flash">${e(error)}</div>` : ""}
    </form>
  `;
}

function renderFeedTabs(activeTab: FeedTab): string {
  return `
    <div class="tab-row">
      <a class="${activeTab === "hot" ? "active" : ""}" href="/?tab=hot">Hot</a>
      <a class="${activeTab === "likes" ? "active" : ""}" href="/?tab=likes">Likes</a>
      <a class="${activeTab === "briefs" ? "active" : ""}" href="/?tab=briefs">Briefs</a>
    </div>
  `;
}

function renderDocumentFeedCard(document: DocumentCard, viewer?: Viewer): string {
  const title = cleanBookTitle(document.title);
  return `
    <article class="feed-card">
      <div class="feed-main">
        <div class="eyebrow">${e(document.kicker)}</div>
        <h2 class="feed-title"><a href="/doc/${e(document.id)}">${e(title)}</a></h2>
        <div class="meta">${e(document.authors.join(", "))} · ${e(document.year)}</div>
        <div class="feed-body">${e(document.summary)}</div>
        <div class="chips">
          ${document.tags.slice(0, 4).map((tag) => `<span class="chip">#${e(tag)}</span>`).join("")}
        </div>
        <div class="row">
          <span class="chip">likes ${document.stats.likes}</span>
          <span class="chip">saves ${document.stats.saves}</span>
        </div>
        <div class="row">
          <a class="button-quiet" href="/doc/${e(document.id)}">Open</a>
          <a class="button-quiet" href="/assistant?docId=${e(document.id)}">Assistant</a>
          ${
            viewer
              ? `
                <form method="post" action="/action/save">
                  <input type="hidden" name="docId" value="${e(document.id)}" />
                  <input type="hidden" name="redirect" value="/" />
                  <button class="${document.saved ? "button" : "button-quiet"}" type="submit">${document.saved ? "Saved" : "Save"}</button>
                </form>
              `
              : ""
          }
        </div>
      </div>
      <div class="feed-preview">
        <div class="preview-kicker">${e(document.kind)}</div>
        <div class="preview-title">${e(title)}</div>
        <div class="preview-foot">${e(document.theme)}</div>
      </div>
    </article>
  `;
}

function renderSearchResults(search: SearchResponse): string {
  return `
    <div class="search-results">
      ${search.results
        .map(
          (result) => `
            <a class="plain-panel" style="padding: 18px;" href="${e(result.href)}">
              <div class="row" style="justify-content: space-between;">
                <strong>${e(result.title)}</strong>
                <span class="chip">${e(result.strategy)}</span>
              </div>
              <div class="small">score <span class="score">${result.score.toFixed(3)}</span></div>
              <div>${e(result.excerpt)}</div>
            </a>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderAssistantComposer(input: {
  redirect: string;
  prompt?: string;
  threadId?: string;
  docId?: string;
  placeholder?: string;
}): string {
  return `
    <form class="assistant-compose" method="post" action="/action/assistant">
      <input type="hidden" name="redirect" value="${e(input.redirect)}" />
      <input type="hidden" name="threadId" value="${e(input.threadId ?? "")}" />
      ${input.docId ? `<input type="hidden" name="docId" value="${e(input.docId)}" />` : ""}
      <textarea name="prompt" placeholder="${e(input.placeholder ?? "Ask anything about this book")}">${e(input.prompt ?? "")}</textarea>
      <div class="row">
        <button class="button" type="submit">Send</button>
      </div>
    </form>
  `;
}

function renderMessage(message: AssistantMessage): string {
  const status =
    message.status === "pending"
      ? `<div class="message-status">Reading deeper across the text now.</div>`
      : message.status === "failed"
        ? `<div class="message-status">The deeper pass failed. The last grounded answer is still saved above.</div>`
        : "";
  const citations =
    message.citations?.length
      ? `
        <div class="citation-list">
          ${message.citations
            .map(
              (citation) => `
                <a class="citation" href="${e(citation.href)}">
                  <strong>${e(citation.label)}</strong>
                  <div class="small">${e(citation.excerpt)}</div>
                </a>
              `,
            )
            .join("")}
        </div>
      `
      : "";
  return `
    <div class="message ${message.role}">
      <div class="eyebrow">${message.role === "user" ? "You" : "Assistant"}</div>
      <div>${e(message.content)}</div>
      ${status}
      ${citations}
    </div>
  `;
}

function renderImportedEvidence(input: {
  evidence: Array<{
    chunk_index: number;
    excerpt: string;
    strategy?: string;
    score?: number;
  }>;
}): string {
  if (!input.evidence.length) {
    return "";
  }
  return `
    <div class="citation-list">
      ${input.evidence
        .slice(0, 6)
        .map(
          (evidence, index) => `
            <a id="evidence-${evidence.chunk_index}" class="citation" href="#evidence-${evidence.chunk_index}">
              <div class="row" style="justify-content: space-between;">
                <strong>Passage ${index + 1}</strong>
                ${
                  evidence.strategy
                    ? `<span class="chip">${e(evidence.strategy)}${evidence.score !== undefined ? ` ${evidence.score.toFixed(3)}` : ""}</span>`
                    : ""
                }
              </div>
              <div class="small">${e(evidence.excerpt)}</div>
            </a>
          `,
        )
        .join("")}
    </div>
  `;
}

function railNav(documentId: string, panel: RailPanel, view: DocumentView, query?: string): string {
  const link = (label: string, nextPanel: RailPanel) =>
    `<a class="${panel === nextPanel ? "active" : ""}" href="/doc/${e(documentId)}?view=${e(view)}&panel=${nextPanel}${
      query ? `&q=${encodeURIComponent(query)}` : ""
    }">${label}</a>`;
  return `
    <div class="tab-row">
      ${link("Assistant", "assistant")}
      ${link("Notes", "notes")}
      ${link("Comments", "comments")}
      ${link("Similar", "similar")}
    </div>
  `;
}

function viewTabs(documentId: string, view: DocumentView, panel: RailPanel, query?: string): string {
  const link = (label: string, nextView: DocumentView) =>
    `<a class="${view === nextView ? "active" : ""}" href="/doc/${e(documentId)}?view=${nextView}&panel=${e(panel)}${
      query ? `&q=${encodeURIComponent(query)}` : ""
    }">${label}</a>`;
  return `
    <div class="tab-row">
      ${link("Document", "document")}
      ${link("Brief", "brief")}
      ${link("Resources", "resources")}
    </div>
  `;
}

export function renderHomePage(input: {
  viewer?: Viewer;
  activeTab: FeedTab;
  documents: DocumentCard[];
  search?: SearchResponse;
  importError?: string;
}): string {
  const feed = input.documents.map((document) => renderDocumentFeedCard(document, input.viewer)).join("");

  const body = `
    <div class="explore-hero">
      <div class="eyebrow">Explore</div>
      <h1 class="page-title">Ask or search anything...</h1>
      ${renderLaunchForm(input.search?.query, input.importError)}
    </div>

    <section class="section">
      ${renderFeedTabs(input.activeTab)}
    </section>

      <section class="section">
        <div class="feed-list">
          ${feed || `<div class="empty">Nothing is loaded yet.</div>`}
        </div>
      </section>
  `;

  return layout("Explore", "Explore", input.viewer, body);
}

export function renderSearchPage(input: {
  viewer?: Viewer;
  query: string;
  search: SearchResponse;
  feedDocuments: DocumentCard[];
  architecture: SearchArchitectureStep[];
}): string {
  const body = `
    <div class="page-head">
      <div class="eyebrow">Search</div>
      <h1 class="page-title">Search results</h1>
      <div class="muted">The dedicated search page is being folded into the assistant. This route remains for direct links.</div>
    </div>

    <div class="search-layout">
      <div class="stack">
        ${renderLaunchForm(input.query)}
        ${renderSearchResults(input.search)}
      </div>
      <aside class="aside">
        <div class="plain-panel" style="padding: 22px;">
          <div class="eyebrow">How it works</div>
          <div class="list">
            ${input.architecture
              .map(
                (step) => `
                  <div class="item">
                    <strong>${e(step.title)}</strong>
                    <div class="small">${e(step.body)}</div>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
      </aside>
    </div>
  `;
  return layout("Search", "Explore", input.viewer, body);
}

export function renderDocumentPage(input: {
  viewer?: Viewer;
  document: DocumentCard;
  view: DocumentView;
  panel: RailPanel;
  sections: DocumentSection[];
  related: DocumentCard[];
  search?: SearchResponse;
  notes: NoteRecord[];
  comments: CommentRecord[];
  thread?: AssistantThread;
  agentEnabled?: boolean;
}): string {
  const doc = input.document;
  const sections =
    input.view === "resources"
      ? `
          <div class="list">
            ${doc.resources
              .map(
                (resource) => `
                  <a class="resource-card" style="padding: 18px;" href="${e(resource.url)}" target="_blank" rel="noreferrer">
                    <div class="row" style="justify-content: space-between;">
                      <strong>${e(resource.label)}</strong>
                      <span class="chip">${e(resource.kind)}</span>
                    </div>
                  </a>
                `,
              )
              .join("")}
          </div>
        `
      : `
          <div class="chat-shell">
            <div class="list">
              ${(input.view === "brief" ? [{ title: "Brief", body: doc.brief }, ...input.sections] : input.sections)
                .map(
                  (section, index) => `
                    <section id="chunk-${index}" class="item">
                      <div class="eyebrow">${input.view === "brief" && index === 0 ? "Brief" : "Passage"}</div>
                      <h2 class="section-title">${e(section.title)}</h2>
                      <div>${e(section.body)}</div>
                    </section>
                  `,
                )
                .join("")}
            </div>
          </div>
        `;

  let railBody = "";
  if (input.panel === "assistant") {
    railBody = `
      <div class="plain-panel" style="padding: 20px;">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
      </div>
      <div class="assistant-rail" style="min-height: auto;">
        <div class="assistant-rail-head">
          <div class="eyebrow">Assistant</div>
          <div class="small">Ask the document without choosing a separate search mode. The faster pass answers first, then deeper work can continue behind it.</div>
        </div>
        <div class="chat-log">
          ${
            input.thread?.messages.length
              ? input.thread.messages.slice(-6).map((message) => renderMessage(message)).join("")
              : `<div class="empty">Start a conversation about this document.</div>`
          }
        </div>
        ${renderAssistantComposer({
          redirect: `/doc/${doc.id}?panel=assistant&view=${input.view}`,
          threadId: input.thread?.id,
          docId: doc.id,
        })}
      </div>
    `;
  } else if (input.panel === "notes") {
    railBody = `
      <div class="plain-panel" style="padding: 20px;">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
      </div>
      <div class="profile-card">
        <div class="eyebrow">Notes</div>
        ${
          input.viewer
            ? `
              <form class="form-grid" method="post" action="/action/note">
                <input type="hidden" name="docId" value="${e(doc.id)}" />
                <input type="hidden" name="redirect" value="/doc/${e(doc.id)}?panel=notes&view=${input.view}" />
                <input name="anchor" placeholder="Anchor" />
                <textarea name="text" placeholder="Private note"></textarea>
                <button class="button" type="submit">Save note</button>
              </form>
            `
            : `<div class="empty"><a href="/signin">Sign in</a> to save notes.</div>`
        }
        <div class="list">
          ${
            input.notes.length
              ? input.notes
                  .map(
                    (note) => `
                      <div class="note">
                        <strong>${e(note.anchor)}</strong>
                        <div>${e(note.text)}</div>
                        <div class="small">${e(formatDate(note.createdAt))}</div>
                      </div>
                    `,
                  )
                  .join("")
              : `<div class="empty">No notes yet.</div>`
          }
        </div>
      </div>
    `;
  } else if (input.panel === "comments") {
    railBody = `
      <div class="plain-panel" style="padding: 20px;">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
      </div>
      <div class="profile-card">
        <div class="eyebrow">Comments</div>
        ${
          input.viewer
            ? `
              <form class="form-grid" method="post" action="/action/comment">
                <input type="hidden" name="docId" value="${e(doc.id)}" />
                <input type="hidden" name="redirect" value="/doc/${e(doc.id)}?panel=comments&view=${input.view}" />
                <textarea name="text" placeholder="Public comment"></textarea>
                <button class="button" type="submit">Post</button>
              </form>
            `
            : `<div class="empty"><a href="/signin">Sign in</a> to comment.</div>`
        }
        <div class="list">
          ${
            input.comments.length
              ? input.comments
                  .map(
                    (comment) => `
                      <div class="comment">
                        <div class="row" style="justify-content: space-between;">
                          <strong>${e(comment.userName)}</strong>
                          <span class="small">@${e(comment.handle)}</span>
                        </div>
                        <div>${e(comment.text)}</div>
                        <div class="small">${e(formatDate(comment.createdAt))}</div>
                      </div>
                    `,
                  )
                  .join("")
              : `<div class="empty">No comments yet.</div>`
          }
        </div>
      </div>
    `;
  } else {
    railBody = `
      <div class="plain-panel" style="padding: 20px;">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
      </div>
      <div class="profile-card">
        <div class="eyebrow">Similar</div>
        <div class="list">
          ${
            input.related.length
              ? input.related.map((related) => renderDocumentFeedCard(related, input.viewer)).join("")
              : `<div class="empty">No related documents are loaded yet.</div>`
          }
        </div>
      </div>
    `;
  }

  const body = `
    <div class="page-head">
      <div class="eyebrow">${e(doc.kicker)}</div>
      <h1 class="doc-title">${e(doc.title)}</h1>
      <div class="meta">${e(doc.authors.join(", "))} · ${e(doc.year)} · ${e(doc.venue)}</div>
      <div class="chips">
        <span class="chip">likes ${doc.stats.likes}</span>
        <span class="chip">saves ${doc.stats.saves}</span>
        <span class="chip">comments ${doc.stats.comments}</span>
      </div>
      <div>${e(doc.summary)}</div>
    </div>

    <div class="doc-layout">
      <div class="stack">
        <section class="section">
          ${viewTabs(doc.id, input.view, input.panel, input.search?.query)}
        </section>
        ${
          input.search?.query
            ? `
              <section class="section">
                <div class="plain-panel" style="padding: 18px;">
                  <div class="eyebrow">Query</div>
                  <div>${e(input.search.query)}</div>
                </div>
              </section>
            `
            : ""
        }
        <section class="section">
          ${sections}
        </section>
      </div>
      <aside class="aside">
        ${railBody}
      </aside>
    </div>
  `;

  return layout(doc.title, "Explore", input.viewer, body);
}

export function renderAssistantPage(input: {
  viewer?: Viewer;
  availableDocs: DocumentCard[];
  threads: AssistantThread[];
  activeThread?: AssistantThread;
  activeDocId?: string;
  prompt?: string;
  agentEnabled?: boolean;
}): string {
  const scopeDocId = input.activeDocId ?? input.activeThread?.docId;
  const leadDoc = input.availableDocs[0];
  const body = `
    <div class="assistant-hero">
      <div class="signal">✦</div>
      <h1 class="page-title">What do you want to learn?</h1>
      <div class="muted">A single assistant surface. Quick retrieval lands first, then deeper reading can continue in the same thread.</div>
    </div>

    <section class="section">
      ${renderAssistantComposer({
        redirect: "/assistant",
        prompt: input.prompt,
        threadId: input.activeThread?.id,
        docId: scopeDocId,
        placeholder: "Ask about a book, a passage, or a theme",
      })}
      ${scopeDocId ? `<div class="footer-note">Current scope: ${e(scopeDocId)}</div>` : ""}
    </section>

    ${
      input.activeThread?.messages.length
        ? `
          <section class="section">
            <div class="chat-shell">
              <div class="row" style="justify-content: space-between; margin-bottom: 16px;">
                <div>
                  <div class="eyebrow">Conversation</div>
                  <h2 class="section-title">${e(input.activeThread.title)}</h2>
                </div>
                <span class="thread-pill">${e(formatDate(input.activeThread.updatedAt))}</span>
              </div>
              <div class="chat-log">
                ${input.activeThread.messages.map((message) => renderMessage(message)).join("")}
              </div>
            </div>
          </section>
        `
        : `
          <section class="section">
            <div class="prompt-grid">
              <div class="prompt-card">
                <div class="eyebrow">Trending</div>
                <h2 class="section-title">Follow a live book</h2>
                <div class="muted">Paste a Gutenberg URL on Explore, then open the reader and ask questions beside the text.</div>
              </div>
              <div class="prompt-card">
                <div class="eyebrow">Grounded</div>
                <h2 class="section-title">Start with evidence</h2>
                <div class="muted">Questions are routed through stored chunks and citations first, so the assistant stays anchored to the book.</div>
              </div>
              ${
                leadDoc
                  ? `
                    <div class="prompt-card">
                      <div class="eyebrow">Live corpus</div>
                      <h2 class="section-title">${e(leadDoc.title)}</h2>
                      <div class="muted">${e(leadDoc.summary)}</div>
                    </div>
                  `
                  : ""
              }
              <div class="prompt-card">
                <div class="eyebrow">Deep read</div>
                <h2 class="section-title">One thread, two passes</h2>
                <div class="muted">The assistant answers quickly, then can continue with a broader scan across the full text in the background.</div>
              </div>
            </div>
          </section>
        `
    }
  `;

  return layout("Assistant", "Assistant", input.viewer, body);
}

export function renderImportedBookPage(input: {
  viewer?: Viewer;
  book: {
    id: string;
    title: string;
    author: string;
    source_url: string;
    text_length: number;
    chunk_count: number;
  };
  sections: Array<{
    chunk_index: number;
    content: string;
    excerpt?: string;
    strategy?: string;
    score?: number;
  }>;
  query?: string;
  thread?: AssistantThread;
  agentEnabled?: boolean;
  readUrl: string;
  fastAnswer?: {
    query: string;
    summary: string;
    evidence: Array<{
      chunk_index: number;
      excerpt: string;
      strategy?: string;
      score?: number;
    }>;
  };
}): string {
  const title = cleanBookTitle(input.book.title);
  const transientMessages: AssistantMessage[] = input.fastAnswer
    ? [
        { role: "user", content: input.fastAnswer.query, createdAt: new Date().toISOString() },
        {
          role: "assistant",
          content: input.fastAnswer.summary,
          createdAt: new Date().toISOString(),
          citations: input.fastAnswer.evidence.slice(0, 4).map((evidence, index) => ({
            label: `Passage ${index + 1}`,
            href: `#evidence-${evidence.chunk_index}`,
            excerpt: evidence.excerpt,
          })),
        },
      ]
    : [];

  const body = `
    <div class="page-head">
      <div class="eyebrow">Reader</div>
      <h1 class="doc-title">${e(title)}</h1>
      <div class="meta">${e(input.book.author)}</div>
    </div>

    <div class="reader-layout">
      <div class="reader-column">
        <div class="row">
          <a class="button-quiet" href="${e(input.book.source_url)}" target="_blank" rel="noreferrer">Open source</a>
        </div>
        <div class="reader-shell">
          <iframe
            class="reader-frame"
            src="${e(input.readUrl)}"
            title="${e(title)}"
            loading="lazy"
            referrerpolicy="no-referrer"
          ></iframe>
        </div>
      </div>

      <aside class="assistant-rail">
        <div class="assistant-rail-head">
          <div class="eyebrow">Assistant</div>
          <div class="small">Ask beside the book. The first answer is grounded in retrieved passages, and a deeper pass can continue in the same thread.</div>
        </div>

        <div class="chat-log">
          ${transientMessages.map((message) => renderMessage(message)).join("")}
          ${
            input.thread?.messages.length
              ? input.thread.messages.slice(-8).map((message) => renderMessage(message)).join("")
              : !input.fastAnswer
                ? `<div class="empty">Ask a question to start a grounded reading thread.</div>`
                : ""
          }
          ${input.fastAnswer ? renderImportedEvidence({ evidence: input.fastAnswer.evidence }) : ""}
        </div>

        <div class="stack">
          ${renderAssistantComposer({
            docId: `book:${input.book.id}`,
            redirect: `/book/${input.book.id}${input.query ? `?q=${encodeURIComponent(input.query)}` : ""}`,
            threadId: input.thread?.id,
            prompt: input.query,
            placeholder: "Ask anything about this book",
          })}
        </div>
      </aside>
    </div>
  `;

  return layout(title, "Explore", input.viewer, body);
}

export function renderLibraryPage(input: {
  viewer?: Viewer;
  savedDocuments: DocumentCard[];
  recentDocuments: DocumentCard[];
  collections: Array<LibraryCollection & { docs: DocumentCard[] }>;
  notesCount: number;
  threadsCount: number;
}): string {
  const body = `
    <div class="page-head">
      <div class="eyebrow">Library</div>
      <h1 class="page-title">Saved work</h1>
      <div class="muted">${input.savedDocuments.length} saved · ${input.notesCount} notes · ${input.threadsCount} threads</div>
    </div>

    <div class="library-layout">
      <div class="stack">
        <section class="section">
          <div class="feed-list">
            ${
              input.savedDocuments.length
                ? input.savedDocuments.map((document) => renderDocumentFeedCard(document, input.viewer)).join("")
                : `<div class="empty">Nothing saved yet.</div>`
            }
          </div>
        </section>
        <section class="section">
          <div class="eyebrow">Recent</div>
          <div class="list">
            ${
              input.recentDocuments.length
                ? input.recentDocuments.map((document) => renderDocumentFeedCard(document, input.viewer)).join("")
                : `<div class="empty">No recent documents.</div>`
            }
          </div>
        </section>
      </div>

      <aside class="aside">
        <div class="profile-card">
          <div class="eyebrow">Collections</div>
          <form class="line-form" method="post" action="/action/collection">
            <input type="hidden" name="redirect" value="/library" />
            <input name="name" placeholder="New collection" />
            <button class="button" type="submit">Create</button>
          </form>
          <div class="list">
            ${
              input.collections.length
                ? input.collections
                    .map(
                      (collection) => `
                        <div class="item">
                          <strong>${e(collection.name)}</strong>
                          <div class="small">${collection.docs.length} docs</div>
                        </div>
                      `,
                    )
                    .join("")
                : `<div class="empty">No collections yet.</div>`
            }
          </div>
        </div>
      </aside>
    </div>
  `;

  return layout("Library", "Library", input.viewer, body);
}

export function renderProfilePage(input: {
  viewer?: Viewer;
  profile: Viewer;
  ownProfile: boolean;
  stats: {
    saved: number;
    notes: number;
    comments: number;
    collections: number;
    threads: number;
  };
  collectionNames: string[];
  historyItems: Array<{
    title: string;
    href: string;
    summary: string;
    meta: string;
    previewLabel: string;
  }>;
}): string {
  const body = `
    <div class="profile-hero">
      ${renderAvatar(input.profile.name, input.profile.avatarUrl, true)}
      <h1 class="profile-name">${e(input.profile.name)}</h1>
      <div class="muted">@${e(input.profile.handle)}</div>
      <div class="muted">${e(input.profile.bio || "No bio yet.")}</div>
      ${
        input.ownProfile
          ? `
            <div class="row">
              <a class="button-quiet" href="/library">Open library</a>
              <form method="post" action="/auth/signout">
                <button class="button-danger" type="submit">Sign out</button>
              </form>
            </div>
          `
          : ""
      }
    </div>

    <section class="section">
      <div class="stat-strip">
        <div class="stat-cell"><strong>${input.stats.saved}</strong><div class="small">Saved</div></div>
        <div class="stat-cell"><strong>${input.stats.notes}</strong><div class="small">Notes</div></div>
        <div class="stat-cell"><strong>${input.stats.comments}</strong><div class="small">Comments</div></div>
        <div class="stat-cell"><strong>${input.stats.collections}</strong><div class="small">Collections</div></div>
        <div class="stat-cell"><strong>${input.stats.threads}</strong><div class="small">Threads</div></div>
      </div>
    </section>

    <section class="section">
      <div class="profile-tabs">
        <div class="profile-tab">Papers</div>
        <div class="profile-tab">Activity</div>
        <div class="profile-tab active">History</div>
      </div>
    </section>

    <div class="profile-layout">
      <div class="profile-main">
        <div class="history-list">
          ${
            input.historyItems.length
              ? input.historyItems
                  .map(
                    (item) => `
                      <a class="history-row" href="${e(item.href)}">
                        <div class="history-preview">${e(item.previewLabel)}</div>
                        <div class="stack" style="gap: 8px;">
                          <h2 class="section-title">${e(item.title)}</h2>
                          <div>${e(item.summary)}</div>
                          <div class="small">${e(item.meta)}</div>
                        </div>
                      </a>
                    `,
                  )
                  .join("")
              : `<div class="empty">No reading history yet.</div>`
          }
        </div>
      </div>

      <aside class="profile-aside">
        <div class="profile-card">
          <div class="eyebrow">Research areas</div>
          <div class="chips">
            ${
              input.profile.interests.length
                ? input.profile.interests.map((interest) => `<span class="chip">${e(interest)}</span>`).join("")
                : `<span class="empty">No research areas yet.</span>`
            }
          </div>
        </div>

        <div class="profile-card">
          <div class="eyebrow">Collections</div>
          <div class="chips">
            ${
              input.collectionNames.length
                ? input.collectionNames.map((name) => `<span class="chip">${e(name)}</span>`).join("")
                : `<span class="empty">No collections yet.</span>`
            }
          </div>
        </div>

        ${
          input.ownProfile
            ? `
              <div class="profile-card">
                <div class="eyebrow">Edit profile</div>
                <form class="auth-panel" method="post" action="/action/profile">
                  <input type="hidden" name="redirect" value="/u/${e(input.profile.handle)}" />
                  <textarea name="bio" placeholder="Bio">${e(input.profile.bio)}</textarea>
                  <input name="interests" value="${e(input.profile.interests.join(", "))}" placeholder="Interests, comma separated" />
                  <button class="button" type="submit">Update</button>
                </form>
              </div>
            `
            : ""
        }
      </aside>
    </div>
  `;

  return layout(input.profile.name, "Profile", input.viewer, body);
}

export function renderLabsPage(input: {
  viewer?: Viewer;
  documents: DocumentCard[];
  architecture: SearchArchitectureStep[];
}): string {
  const body = `
    <div class="page-head">
      <div class="eyebrow">Assistant</div>
      <h1 class="page-title">The assistant is the new primary surface.</h1>
      <div class="muted">This legacy route is being retired. Use Explore to import or Assistant to ask questions.</div>
      <div class="row">
        <a class="button" href="/assistant">Open assistant</a>
        <a class="button-quiet" href="/">Back to explore</a>
      </div>
    </div>
  `;
  return layout("Assistant", "Assistant", input.viewer, body);
}

export function renderAuthPage(input: {
  mode: "signin" | "signup";
  error?: string;
  authConfigured: boolean;
  next?: string;
  origin?: string;
}): string {
  const body = `
    <div class="auth-wrap">
      <div class="page-head">
        <div class="eyebrow">Sign in</div>
        <h1 class="auth-title">Continue into AlphaBook</h1>
      </div>

      <section class="section">
        <div class="auth-box">
          ${input.error ? `<div class="flash">${e(input.error)}</div>` : ""}
          ${
            input.authConfigured
              ? `<a class="button" href="/auth/google/start${input.next ? `?next=${encodeURIComponent(input.next)}` : ""}">Sign in with Google</a>`
              : `
                <div class="flash">WorkOS Google auth is not configured in this Worker yet.</div>
                <div class="list">
                  <div class="item">
                    <strong>1. Create a WorkOS app</strong>
                    <div class="small">Enable Google social auth in AuthKit.</div>
                  </div>
                  <div class="item">
                    <strong>2. Add this redirect URI</strong>
                    <div class="small">${e(`${input.origin ?? "https://your-domain.example"}/auth/google/callback`)}</div>
                  </div>
                  <div class="item">
                    <strong>3. Set Worker secrets</strong>
                    <div class="small">WORKOS_CLIENT_ID and WORKOS_API_KEY</div>
                  </div>
                </div>
              `
          }
        </div>
      </section>
    </div>
  `;
  return layout("Sign in", "Explore", undefined, body);
}

export function renderOnboardingPage(input: { viewer?: Viewer }): string {
  const viewer = input.viewer;
  const body = `
    <div class="auth-wrap">
      <div class="page-head">
        <div class="eyebrow">Onboarding</div>
        <h1 class="page-title">Set up your reading profile</h1>
      </div>

      <section class="section">
        <form class="auth-panel" method="post" action="/action/onboarding">
          <input type="hidden" name="redirect" value="/" />
          <textarea name="bio" placeholder="Bio">${e(viewer?.bio ?? "")}</textarea>
          <input name="interests" value="${e(viewer?.interests.join(", ") ?? "")}" placeholder="Interests, comma separated" />
          <button class="button" type="submit">Save</button>
        </form>
      </section>
    </div>
  `;
  return layout("Onboarding", "Explore", viewer, body);
}

export function renderNotFound(viewer?: Viewer): string {
  const body = `
    <div class="page-head">
      <div class="eyebrow">404</div>
      <h1 class="page-title">Page not found</h1>
      <div class="row">
        <a class="button" href="/">Go home</a>
        <a class="button-quiet" href="/assistant">Open assistant</a>
      </div>
    </div>
  `;
  return layout("Not found", "Explore", viewer, body);
}
