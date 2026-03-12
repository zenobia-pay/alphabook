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
  --paper: #fbf8f2;
  --ink: #171717;
  --muted: #6a655d;
  --line: rgba(23, 23, 23, 0.12);
  --line-strong: rgba(23, 23, 23, 0.2);
  --accent: #1f4b74;
  --accent-soft: rgba(31, 75, 116, 0.08);
  --success: #1d5d3e;
  --danger: #8a302f;
  --radius: 18px;
}

* {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  background: var(--bg);
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
  grid-template-columns: 280px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  padding: 28px 24px;
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  gap: 28px;
}

.brand {
  display: grid;
  gap: 6px;
}

.brand-title {
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: 1.85rem;
  letter-spacing: -0.04em;
}

.brand-meta,
.muted,
.meta,
.small {
  color: var(--muted);
}

.nav {
  display: grid;
  gap: 6px;
}

.nav a,
.nav button,
.tab-row a,
.rail-tabs a {
  border-radius: 999px;
  padding: 10px 14px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
}

.nav a.active,
.tab-row a.active,
.rail-tabs a.active {
  background: rgba(255, 255, 255, 0.72);
  color: var(--ink);
}

.sidebar-block {
  display: grid;
  gap: 10px;
}

.sidebar-viewer {
  display: grid;
  gap: 12px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  object-fit: cover;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid var(--line);
}

.viewer-line {
  display: flex;
  align-items: center;
  gap: 12px;
}

.main {
  padding: 36px 40px 48px;
}

.page {
  max-width: 1120px;
}

.page-head {
  display: grid;
  gap: 12px;
  margin-bottom: 28px;
}

.page-title,
.doc-title,
.auth-title {
  margin: 0;
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: clamp(2.2rem, 4vw, 3.6rem);
  line-height: 0.96;
  letter-spacing: -0.05em;
}

.eyebrow {
  color: var(--muted);
  font-size: 0.76rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.stack {
  display: grid;
  gap: 20px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.button,
.button-quiet,
.button-danger {
  min-height: 42px;
  padding: 0 16px;
  border-radius: 999px;
  border: 1px solid transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.button {
  background: var(--ink);
  color: white;
}

.button-quiet {
  background: transparent;
  color: var(--ink);
  border-color: var(--line);
}

.button-danger {
  background: transparent;
  color: var(--danger);
  border-color: rgba(138, 48, 47, 0.22);
}

.query-form,
.composer,
.auth-panel,
.line-form {
  display: grid;
  gap: 12px;
}

.query-form input,
.query-form textarea,
.composer input,
.composer textarea,
.composer select,
.auth-panel input,
.auth-panel textarea,
.line-form input,
.line-form textarea {
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--paper);
  min-height: 52px;
  padding: 14px 16px;
  color: var(--ink);
}

.query-form textarea,
.composer textarea,
.auth-panel textarea {
  min-height: 124px;
  resize: vertical;
}

.tab-row,
.rail-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.section {
  padding: 22px 0;
  border-top: 1px solid var(--line);
}

.section:first-child {
  border-top: none;
  padding-top: 0;
}

.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 36px;
  align-items: start;
}

.two-up {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 28px;
}

.list {
  display: grid;
  gap: 14px;
}

.item,
.note,
.comment,
.thread,
.resource,
.plain-panel,
.auth-box {
  padding: 16px 0;
  border-top: 1px solid var(--line);
}

.item:first-child,
.note:first-child,
.comment:first-child,
.thread:first-child,
.resource:first-child {
  border-top: none;
  padding-top: 0;
}

.doc-row {
  display: grid;
  gap: 8px;
}

.doc-row h2,
.doc-row h3,
.panel-title,
.section-title {
  margin: 0;
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  line-height: 1;
}

.doc-row h2 {
  font-size: 1.55rem;
}

.doc-meta,
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.72);
  color: var(--muted);
  font-size: 0.8rem;
}

.score {
  font-variant-numeric: tabular-nums;
}

.search-layout,
.doc-layout,
.assistant-layout,
.library-layout,
.profile-layout,
.labs-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 36px;
  align-items: start;
}

.aside {
  display: grid;
  gap: 20px;
  position: sticky;
  top: 36px;
}

.aside .plain-panel {
  padding-top: 0;
}

.reader-shell {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  background: white;
  min-height: 76vh;
}

.reader-frame {
  width: 100%;
  min-height: 76vh;
  border: 0;
  display: block;
  background: white;
}

.match-card {
  display: grid;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
}

.match-card:first-child {
  border-top: none;
  padding-top: 0;
}

.chat-log {
  display: grid;
  gap: 14px;
}

.bubble {
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.58);
}

.bubble.user {
  background: var(--accent-soft);
}

.empty {
  color: var(--muted);
  padding: 4px 0;
}

.flash {
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(138, 48, 47, 0.08);
  color: var(--danger);
}

.success {
  color: var(--success);
}

.footer-note {
  margin-top: 40px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.9rem;
}

@media (max-width: 1040px) {
  .shell,
  .split,
  .search-layout,
  .doc-layout,
  .assistant-layout,
  .library-layout,
  .profile-layout,
  .labs-layout,
  .two-up {
    grid-template-columns: 1fr;
  }

  .sidebar {
    position: static;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }

  .aside {
    position: static;
    top: auto;
  }

  .reader-shell,
  .reader-frame {
    min-height: 58vh;
  }
}

@media (max-width: 720px) {
  .main {
    padding: 24px 20px 36px;
  }

  .sidebar {
    padding: 22px 20px;
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

function viewerControls(viewer?: Viewer): string {
  if (!viewer) {
    return `
      <a class="button" href="/signin">Sign in</a>
    `;
  }

  return `
    <div class="viewer-line">
      ${viewer.avatarUrl ? `<img class="avatar" src="${e(viewer.avatarUrl)}" alt="${e(viewer.name)}" />` : `<div class="avatar"></div>`}
      <div>
        <div>${e(viewer.name)}</div>
        <div class="small">@${e(viewer.handle)}</div>
      </div>
    </div>
    <div class="row">
      <a class="button-quiet" href="/u/${e(viewer.handle)}">Profile</a>
      <form method="post" action="/auth/signout">
        <button class="button-danger" type="submit">Sign out</button>
      </form>
    </div>
  `;
}

function sidebar(activeNav: string, viewer?: Viewer): string {
  const nav = [
    ["Explore", "/"],
    ["Search", "/search"],
    ["Assistant", "/assistant"],
    ["Library", "/library"],
    ["Labs", "/labs"],
  ];

  return `
    <aside class="sidebar">
      <a class="brand" href="/">
        <div class="brand-title">alphabook</div>
        <div class="brand-meta">public-domain book research</div>
      </a>
      <nav class="nav">
        ${nav
          .map(
            ([label, href]) =>
              `<a class="${activeNav === label ? "active" : ""}" href="${href}">${label}</a>`,
          )
          .join("")}
        ${viewer ? `<a class="${activeNav === "Profile" ? "active" : ""}" href="/u/${e(viewer.handle)}">Profile</a>` : ""}
      </nav>
      <div class="sidebar-block">
        <div class="eyebrow">Project Gutenberg</div>
        <div>Paste a reading URL to import a book.</div>
      </div>
      <div class="sidebar-viewer">${viewerControls(viewer)}</div>
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

function renderSearchForm(query?: string, action = "/search"): string {
  return `
    <form class="query-form" method="get" action="${action}">
      <textarea name="q" placeholder="Ask or search anything...">${e(query ?? "")}</textarea>
      <div class="row">
        <button class="button" type="submit">Search</button>
        <a class="button-quiet" href="/assistant${query ? `?prompt=${encodeURIComponent(query)}` : ""}">Send to assistant</a>
      </div>
    </form>
  `;
}

function renderImportForm(error?: string): string {
  return `
    <form class="query-form" method="post" action="/action/import-book">
      <input type="text" name="url" placeholder="Paste a Project Gutenberg book URL" />
      <div class="row">
        <button class="button" type="submit">Import book</button>
      </div>
      ${error ? `<div class="flash">${e(error)}</div>` : ""}
    </form>
  `;
}

function renderImportedBookRow(book: {
  id: string;
  title: string;
  author: string;
  chunkCount: number;
  sourceUrl: string;
}): string {
  return `
    <article class="doc-row">
      <div class="eyebrow">Imported book</div>
      <h2><a href="/book/${e(book.id)}">${e(book.title)}</a></h2>
      <div class="meta">${e(book.author)} · ${book.chunkCount} chunks</div>
      <div class="row">
        <a class="button-quiet" href="/book/${e(book.id)}">Open</a>
        <a class="button-quiet" href="${e(book.sourceUrl)}" target="_blank" rel="noreferrer">Source</a>
      </div>
    </article>
  `;
}

function renderDocSummary(document: DocumentCard, viewer?: Viewer): string {
  return `
    <article class="doc-row">
      <div class="eyebrow">${e(document.kicker)}</div>
      <h2><a href="/doc/${e(document.id)}">${e(document.title)}</a></h2>
      <div class="meta">${e(document.authors.join(", "))} · ${e(document.year)} · ${e(document.venue)}</div>
      <div class="chips">
        <span class="chip">${e(document.kind)}</span>
        <span class="chip">${e(document.fullTextLabel)}</span>
        <span class="chip">likes ${document.stats.likes}</span>
        <span class="chip">saves ${document.stats.saves}</span>
      </div>
      <div>${e(document.summary)}</div>
      <div class="row">
        <a class="button-quiet" href="/doc/${e(document.id)}">Open</a>
        <a class="button-quiet" href="/assistant?docId=${e(document.id)}">Ask</a>
        ${
          viewer
            ? `
              <form method="post" action="/action/save">
                <input type="hidden" name="docId" value="${e(document.id)}" />
                <input type="hidden" name="redirect" value="/doc/${e(document.id)}" />
                <button class="${document.saved ? "button" : "button-quiet"}" type="submit">${document.saved ? "Saved" : "Save"}</button>
              </form>
            `
            : ""
        }
      </div>
    </article>
  `;
}

function renderSearchResults(search: SearchResponse): string {
  return `
    <div class="list">
      ${search.results
        .map(
          (result) => `
            <a class="item" href="${e(result.href)}">
              <div class="row" style="justify-content: space-between;">
                <strong>${e(result.title)}</strong>
                <span class="chip">${e(result.strategy)}</span>
              </div>
              <div class="meta">score <span class="score">${result.score.toFixed(3)}</span></div>
              <div>${e(result.excerpt)}</div>
            </a>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderAssistantComposer(input: {
  docId?: string;
  redirect: string;
  activeDocId?: string;
  prompt?: string;
  threadId?: string;
  agentEnabled?: boolean;
}): string {
  return `
    <form class="composer" method="post" action="/action/assistant">
      <input type="hidden" name="redirect" value="${e(input.redirect)}" />
      <input type="hidden" name="threadId" value="${e(input.threadId ?? "")}" />
      ${input.docId ? `<input type="hidden" name="docId" value="${e(input.docId)}" />` : ""}
      ${
        input.docId
          ? ""
          : `
            <select name="docId">
              <option value="">Entire corpus</option>
              <option value="don-quixote" ${input.activeDocId === "don-quixote" ? "selected" : ""}>Don Quixote</option>
            </select>
          `
      }
      <select name="mode">
        <option value="fast">Fast</option>
        <option value="agent" ${input.agentEnabled ? "" : "disabled"}>Agent</option>
      </select>
      <textarea name="prompt" placeholder="Ask a question about the book">${e(input.prompt ?? "")}</textarea>
      <button class="button" type="submit">Send</button>
    </form>
  `;
}

function railNav(documentId: string, panel: RailPanel, view: DocumentView, query?: string): string {
  const link = (label: string, nextPanel: RailPanel) =>
    `<a class="${panel === nextPanel ? "active" : ""}" href="/doc/${e(documentId)}?view=${e(view)}&panel=${nextPanel}${
      query ? `&q=${encodeURIComponent(query)}` : ""
    }">${label}</a>`;

  return `
    <div class="rail-tabs">
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
  importedBooks: Array<{
    id: string;
    title: string;
    author: string;
    chunkCount: number;
    sourceUrl: string;
  }>;
}): string {
  const [document] = input.documents;
  const body = `
    <div class="page-head">
      <div class="eyebrow">Explore</div>
      <h1 class="page-title">Import a Gutenberg book.</h1>
    </div>

    <section class="section">
      <div class="eyebrow">Import</div>
      ${renderImportForm(input.importError)}
    </section>

    <section class="section">
      <div class="eyebrow">Search</div>
      ${renderSearchForm(input.search?.query, "/search")}
    </section>

    ${
      input.importedBooks.length
        ? `
          <section class="section">
            <div class="eyebrow">Imported</div>
            <div class="list">
              ${input.importedBooks.map((book) => renderImportedBookRow(book)).join("")}
            </div>
          </section>
        `
        : ""
    }

    <section class="section">
      <div class="tab-row">
        <a class="${input.activeTab === "hot" ? "active" : ""}" href="/?tab=hot">Hot</a>
        <a class="${input.activeTab === "likes" ? "active" : ""}" href="/?tab=likes">Likes</a>
        <a class="${input.activeTab === "briefs" ? "active" : ""}" href="/?tab=briefs">Briefs</a>
      </div>
    </section>

    <section class="section">
      ${document ? renderDocSummary(document, input.viewer) : `<div class="empty">No documents loaded.</div>`}
    </section>

    ${
      input.search
        ? `
          <section class="section">
            <div class="eyebrow">Search</div>
            <h2 class="section-title">Top hits for “${e(input.search.query)}”</h2>
            ${renderSearchResults(input.search)}
          </section>
        `
        : ""
    }
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
      <h1 class="page-title">Route first. Read second.</h1>
    </div>

    <div class="search-layout">
      <div class="stack">
        <section class="section">
          ${renderSearchForm(input.query)}
        </section>
        <section class="section">
          <div class="eyebrow">Results</div>
          <h2 class="section-title">${input.search.results.length} hits for “${e(input.query)}”</h2>
          ${renderSearchResults(input.search)}
        </section>
      </div>
      <aside class="aside">
        <section class="plain-panel">
          <div class="eyebrow">How it works</div>
          <div class="list">
            ${input.architecture
              .map(
                (step) => `
                  <div class="item">
                    <strong>${e(step.title)}</strong>
                    <div class="muted">${e(step.body)}</div>
                  </div>
                `,
              )
              .join("")}
          </div>
        </section>
        <section class="plain-panel">
          <div class="eyebrow">Current document</div>
          ${input.feedDocuments[0] ? renderDocSummary(input.feedDocuments[0], input.viewer) : ""}
        </section>
      </aside>
    </div>
  `;

  return layout("Search", "Search", input.viewer, body);
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
                  <a class="resource" href="${e(resource.url)}" target="_blank" rel="noreferrer">
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
        `;

  let railBody = "";
  if (input.panel === "assistant") {
    railBody = `
      <section class="plain-panel">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
      </section>
      <section class="plain-panel">
        <div class="eyebrow">Assistant</div>
        ${
          input.thread?.messages.length
            ? `
              <div class="chat-log">
                ${input.thread.messages
                  .slice(-4)
                  .map(
                    (message) => `
                      <div class="bubble ${message.role}">
                        <div class="eyebrow">${message.role === "user" ? "You" : "Assistant"}${
                          message.mode ? ` · ${message.mode}` : ""
                        }${message.status === "pending" ? " · running" : message.status === "failed" ? " · failed" : ""}</div>
                        <div>${e(message.content)}</div>
                      </div>
                    `,
                  )
                  .join("")}
              </div>
            `
            : `<div class="empty">No thread for this document yet.</div>`
        }
        ${renderAssistantComposer({
          docId: doc.id,
          redirect: `/doc/${doc.id}?panel=assistant&view=${input.view}`,
          threadId: input.thread?.id,
          agentEnabled: input.agentEnabled,
        })}
      </section>
    `;
  } else if (input.panel === "notes") {
    railBody = `
      <section class="plain-panel">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
      </section>
      <section class="plain-panel">
        <div class="eyebrow">Notes</div>
        ${
          input.viewer
            ? `
              <form class="composer" method="post" action="/action/note">
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
      </section>
    `;
  } else if (input.panel === "comments") {
    railBody = `
      <section class="plain-panel">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
      </section>
      <section class="plain-panel">
        <div class="eyebrow">Comments</div>
        ${
          input.viewer
            ? `
              <form class="composer" method="post" action="/action/comment">
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
      </section>
    `;
  } else {
    railBody = `
      <section class="plain-panel">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
      </section>
      <section class="plain-panel">
        <div class="eyebrow">Similar</div>
        ${
          input.related.length
            ? input.related.map((related) => renderDocSummary(related, input.viewer)).join("")
            : `<div class="empty">No other ingested books yet.</div>`
        }
      </section>
    `;
  }

  const body = `
    <div class="page-head">
      <div class="eyebrow">${e(doc.kicker)}</div>
      <h1 class="doc-title">${e(doc.title)}</h1>
      <div class="meta">${e(doc.authors.join(", "))} · ${e(doc.year)} · ${e(doc.venue)}</div>
      <div class="chips">
        <span class="chip">${e(doc.fullTextLabel)}</span>
        <span class="chip">likes ${doc.stats.likes}</span>
        <span class="chip">saves ${doc.stats.saves}</span>
        <span class="chip">comments ${doc.stats.comments}</span>
      </div>
      <div>${e(doc.summary)}</div>
      <div class="row">
        <a class="button-quiet" href="/assistant?docId=${e(doc.id)}">Open assistant</a>
        ${doc.resources[0] ? `<a class="button-quiet" href="${e(doc.resources[0].url)}" target="_blank" rel="noreferrer">Source</a>` : ""}
        ${
          input.viewer
            ? `
              <form method="post" action="/action/like">
                <input type="hidden" name="docId" value="${e(doc.id)}" />
                <input type="hidden" name="redirect" value="/doc/${e(doc.id)}?panel=${input.panel}&view=${input.view}" />
                <button class="${doc.liked ? "button" : "button-quiet"}" type="submit">${doc.liked ? "Liked" : "Like"}</button>
              </form>
              <form method="post" action="/action/save">
                <input type="hidden" name="docId" value="${e(doc.id)}" />
                <input type="hidden" name="redirect" value="/doc/${e(doc.id)}?panel=${input.panel}&view=${input.view}" />
                <button class="${doc.saved ? "button" : "button-quiet"}" type="submit">${doc.saved ? "Saved" : "Save"}</button>
              </form>
            `
            : ""
        }
      </div>
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
                <div class="eyebrow">Query overlay</div>
                <div>${e(input.search.query)}</div>
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
  const body = `
    <div class="page-head">
      <div class="eyebrow">Assistant</div>
      <h1 class="page-title">Persistent research threads.</h1>
    </div>

    <div class="assistant-layout">
      <div class="stack">
        <section class="section">
          ${
            input.viewer
              ? `
                ${renderAssistantComposer({
                  redirect: "/assistant",
                  activeDocId: input.activeDocId,
                  prompt: input.prompt,
                  threadId: input.activeThread?.id,
                  agentEnabled: input.agentEnabled,
                })}
              `
              : `<div class="empty"><a href="/signin">Sign in</a> to save assistant threads.</div>`
          }
        </section>
        <section class="section">
          <div class="eyebrow">Conversation</div>
          <div class="chat-log">
            ${
              input.activeThread?.messages.length
                ? input.activeThread.messages
                    .map(
                      (message) => `
                        <div class="bubble ${message.role}">
                          <div class="eyebrow">${message.role === "user" ? "You" : "Assistant"}${
                            message.mode ? ` · ${message.mode}` : ""
                          }${message.status === "pending" ? " · running" : message.status === "failed" ? " · failed" : ""}</div>
                          <div>${e(message.content)}</div>
                          ${
                            message.citations?.length
                              ? `
                                <div class="chips" style="margin-top: 10px;">
                                  ${message.citations
                                    .map((citation) => `<a class="chip" href="${e(citation.href)}">${e(citation.label)}</a>`)
                                    .join("")}
                                </div>
                              `
                              : ""
                          }
                        </div>
                      `,
                    )
                    .join("")
                : `<div class="empty">Start a thread to save a query and the synthesized answer.</div>`
            }
          </div>
        </section>
      </div>

      <aside class="aside">
        <section class="plain-panel">
          <div class="eyebrow">Threads</div>
          <div class="list">
            ${
              input.threads.length
                ? input.threads
                    .map(
                      (thread) => `
                        <a class="thread" href="/assistant?threadId=${e(thread.id)}">
                          <strong>${e(thread.title)}</strong>
                          <div class="small">${thread.docId ? e(thread.docId) : "corpus-wide"} · ${e(
                            formatDate(thread.updatedAt),
                          )}</div>
                        </a>
                      `,
                    )
                    .join("")
                : `<div class="empty">No saved threads.</div>`
            }
          </div>
        </section>
      </aside>
    </div>
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
}): string {
  const body = `
    <div class="page-head">
      <div class="eyebrow">Imported book</div>
      <h1 class="doc-title">${e(input.book.title)}</h1>
      <div class="meta">${e(input.book.author)} · Project Gutenberg</div>
      <div class="row">
        <a class="button-quiet" href="${e(input.book.source_url)}" target="_blank" rel="noreferrer">Source</a>
      </div>
    </div>

    <div class="doc-layout">
      <div class="stack">
        <section class="section">
          <form class="query-form" method="get" action="/book/${e(input.book.id)}">
            <input type="text" name="q" value="${e(input.query ?? "")}" placeholder="Search inside this book" />
            <div class="row">
              <button class="button" type="submit">Search book</button>
            </div>
          </form>
        </section>
        <section class="section">
          <div class="reader-shell">
            <iframe
              class="reader-frame"
              src="${e(input.readUrl)}"
              title="${e(input.book.title)}"
              loading="lazy"
              referrerpolicy="no-referrer"
            ></iframe>
          </div>
        </section>
      </div>

      <aside class="aside">
        ${
          input.query && input.sections.length
            ? `
              <section class="plain-panel">
                <div class="eyebrow">Relevant passages</div>
                ${input.sections
                  .map(
                    (section, index) => `
                      <div id="evidence-${section.chunk_index}" class="match-card">
                        <div class="row" style="justify-content: space-between;">
                          <strong>Passage ${index + 1}</strong>
                          ${
                            section.strategy
                              ? `<span class="chip">${e(section.strategy)}${section.score !== undefined ? ` ${section.score.toFixed(3)}` : ""}</span>`
                              : ""
                          }
                        </div>
                        <div>${e(section.excerpt ?? section.content)}</div>
                      </div>
                    `,
                  )
                  .join("")}
              </section>
            `
            : ""
        }
        <section class="plain-panel">
          <div class="eyebrow">Assistant</div>
          ${
            input.thread?.messages.length
              ? `
                <div class="chat-log">
                  ${input.thread.messages
                    .slice(-6)
                    .map(
                      (message) => `
                        <div class="bubble ${message.role}">
                          <div class="eyebrow">${message.role === "user" ? "You" : "Assistant"}${
                            message.mode ? ` · ${message.mode}` : ""
                          }${message.status === "pending" ? " · running" : message.status === "failed" ? " · failed" : ""}</div>
                          <div>${e(message.content)}</div>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
              `
              : `<div class="empty">Ask a question about this book.</div>`
          }
          ${renderAssistantComposer({
            docId: `book:${input.book.id}`,
            redirect: `/book/${input.book.id}${input.query ? `?q=${encodeURIComponent(input.query)}` : ""}`,
            threadId: input.thread?.id,
            agentEnabled: input.agentEnabled,
          })}
        </section>
      </aside>
    </div>
  `;

  return layout(input.book.title, "Explore", input.viewer, body);
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
      <h1 class="page-title">Saved work.</h1>
      <div class="muted">${input.savedDocuments.length} saved · ${input.notesCount} notes · ${input.threadsCount} threads</div>
    </div>

    <div class="library-layout">
      <div class="stack">
        <section class="section">
          <div class="eyebrow">Saved</div>
          <div class="list">
            ${
              input.savedDocuments.length
                ? input.savedDocuments.map((document) => renderDocSummary(document, input.viewer)).join("")
                : `<div class="empty">Nothing saved yet.</div>`
            }
          </div>
        </section>
        <section class="section">
          <div class="eyebrow">Recent</div>
          <div class="list">
            ${
              input.recentDocuments.length
                ? input.recentDocuments.map((document) => renderDocSummary(document, input.viewer)).join("")
                : `<div class="empty">No recent documents.</div>`
            }
          </div>
        </section>
      </div>
      <aside class="aside">
        <section class="plain-panel">
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
        </section>
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
}): string {
  const body = `
    <div class="page-head">
      <div class="eyebrow">Profile</div>
      <h1 class="page-title">${e(input.profile.name)}</h1>
      <div class="muted">@${e(input.profile.handle)} · ${e(input.profile.email)}</div>
    </div>

    <div class="profile-layout">
      <div class="stack">
        <section class="section">
          <div>${e(input.profile.bio || "No bio yet.")}</div>
        </section>
        <section class="section">
          <div class="chips">
            <span class="chip">saved ${input.stats.saved}</span>
            <span class="chip">notes ${input.stats.notes}</span>
            <span class="chip">comments ${input.stats.comments}</span>
            <span class="chip">collections ${input.stats.collections}</span>
            <span class="chip">threads ${input.stats.threads}</span>
          </div>
        </section>
        <section class="section">
          <div class="eyebrow">Interests</div>
          <div class="chips">
            ${
              input.profile.interests.length
                ? input.profile.interests.map((interest) => `<span class="chip">${e(interest)}</span>`).join("")
                : `<span class="empty">No interests yet.</span>`
            }
          </div>
        </section>
      </div>
      <aside class="aside">
        <section class="plain-panel">
          <div class="eyebrow">Collections</div>
          <div class="list">
            ${
              input.collectionNames.length
                ? input.collectionNames.map((name) => `<div class="item">${e(name)}</div>`).join("")
                : `<div class="empty">No collections yet.</div>`
            }
          </div>
        </section>
        ${
          input.ownProfile
            ? `
              <section class="plain-panel">
                <div class="eyebrow">Edit</div>
                <form class="auth-panel" method="post" action="/action/profile">
                  <input type="hidden" name="redirect" value="/u/${e(input.profile.handle)}" />
                  <textarea name="bio" placeholder="Bio">${e(input.profile.bio)}</textarea>
                  <input name="interests" value="${e(input.profile.interests.join(", "))}" placeholder="Interests, comma separated" />
                  <button class="button" type="submit">Update</button>
                </form>
              </section>
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
      <div class="eyebrow">Labs</div>
      <h1 class="page-title">How the search stack works.</h1>
    </div>

    <div class="labs-layout">
      <div class="stack">
        <section class="section">
          <div class="list">
            ${input.architecture
              .map(
                (step) => `
                  <div class="item">
                    <strong>${e(step.title)}</strong>
                    <div>${e(step.body)}</div>
                  </div>
                `,
              )
              .join("")}
          </div>
        </section>
        <section class="section">
          <div class="eyebrow">Current implementation</div>
          <div class="list">
            <div class="item">
              <strong>Fast search</strong>
              <div>Local hashed embeddings plus lexical matching rank the book and its chunks.</div>
            </div>
            <div class="item">
              <strong>Agentic slow search</strong>
              <div>The slow mode widens the evidence set and returns a synthesis over more chunk hits for the same book.</div>
            </div>
            <div class="item">
              <strong>Naive mode</strong>
              <div>The exhaustive path is ready for a multi-book corpus, but with one live book it behaves as the widest sweep over Don Quixote.</div>
            </div>
          </div>
        </section>
      </div>
      <aside class="aside">
        <section class="plain-panel">
          <div class="eyebrow">Live document</div>
          ${input.documents[0] ? renderDocSummary(input.documents[0], input.viewer) : `<div class="empty">No document loaded.</div>`}
        </section>
      </aside>
    </div>
  `;

  return layout("Labs", "Labs", input.viewer, body);
}

export function renderAuthPage(input: {
  mode: "signin" | "signup";
  error?: string;
  authConfigured: boolean;
  next?: string;
  origin?: string;
}): string {
  const body = `
    <div class="page-head">
      <div class="eyebrow">Sign in</div>
      <h1 class="auth-title">Sign in</h1>
    </div>

    <section class="section">
      <div class="auth-box">
        ${input.error ? `<div class="flash">${e(input.error)}</div>` : ""}
        ${
          input.authConfigured
            ? `
              <a class="button" href="/auth/google/start${input.next ? `?next=${encodeURIComponent(input.next)}` : ""}">Sign in</a>
            `
            : `
              <div class="flash">WorkOS Google auth is not configured in this Worker yet.</div>
              <div class="list">
                <div class="item">
                  <strong>1. Create a WorkOS app</strong>
                  <div class="muted">Enable Google social auth in AuthKit.</div>
                </div>
                <div class="item">
                  <strong>2. Add this redirect URI</strong>
                  <div class="muted">${e(`${input.origin ?? "https://your-domain.example"}/auth/google/callback`)}</div>
                </div>
                <div class="item">
                  <strong>3. Set Worker secrets</strong>
                  <div class="muted">WORKOS_CLIENT_ID and WORKOS_API_KEY</div>
                </div>
              </div>
            `
        }
      </div>
    </section>
  `;

  return layout("Sign in", "Explore", undefined, body);
}

export function renderOnboardingPage(input: { viewer?: Viewer }): string {
  const viewer = input.viewer;
  const body = `
    <div class="page-head">
      <div class="eyebrow">Onboarding</div>
      <h1 class="page-title">Finish your profile.</h1>
    </div>

    <section class="section">
      <form class="auth-panel" method="post" action="/action/onboarding">
        <input type="hidden" name="redirect" value="/" />
        <textarea name="bio" placeholder="Bio">${e(viewer?.bio ?? "")}</textarea>
        <input name="interests" value="${e(viewer?.interests.join(", ") ?? "")}" placeholder="Interests, comma separated" />
        <button class="button" type="submit">Save</button>
      </form>
    </section>
  `;

  return layout("Onboarding", "Explore", viewer, body);
}

export function renderNotFound(viewer?: Viewer): string {
  const body = `
    <div class="page-head">
      <div class="eyebrow">404</div>
      <h1 class="page-title">Page not found.</h1>
      <div class="row">
        <a class="button" href="/">Go home</a>
        <a class="button-quiet" href="/search">Search</a>
      </div>
    </div>
  `;

  return layout("Not found", "Explore", viewer, body);
}
