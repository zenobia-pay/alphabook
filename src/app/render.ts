import type {
  AssistantCitation,
  DocumentCard,
  DocumentSection,
  DocumentView,
  FeedTab,
  RailPanel,
  SearchResponse,
  SeedDocument,
} from "./data";

export interface Viewer {
  id: string;
  name: string;
  handle: string;
  email: string;
  bio: string;
  interests: string[];
  onboardingComplete: boolean;
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
  --bg: #f6efe4;
  --bg-elevated: rgba(255, 252, 247, 0.82);
  --surface: rgba(18, 29, 36, 0.94);
  --surface-soft: rgba(23, 37, 46, 0.82);
  --surface-muted: rgba(27, 41, 50, 0.68);
  --card: rgba(255, 249, 242, 0.86);
  --card-strong: rgba(255, 252, 247, 0.98);
  --text: #12222b;
  --text-soft: #4b5b63;
  --text-on-dark: #eef3f2;
  --line: rgba(15, 27, 34, 0.12);
  --line-strong: rgba(15, 27, 34, 0.24);
  --accent: #a04d2e;
  --accent-2: #0f7f84;
  --accent-3: #d1b05f;
  --danger: #992c2c;
  --shadow: 0 18px 50px rgba(24, 34, 41, 0.14);
  --radius-xl: 28px;
  --radius-lg: 20px;
  --radius-md: 14px;
  --radius-sm: 10px;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background:
    radial-gradient(circle at top left, rgba(15, 127, 132, 0.12), transparent 34%),
    radial-gradient(circle at bottom right, rgba(160, 77, 46, 0.1), transparent 24%),
    linear-gradient(180deg, #faf4ea 0%, #f2e8da 100%);
  color: var(--text);
  font-family: "Avenir Next Condensed", "Gill Sans", "Trebuchet MS", sans-serif;
  min-height: 100%;
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(rgba(255,255,255,0.28), rgba(255,255,255,0.28)),
    repeating-linear-gradient(
      0deg,
      rgba(87, 69, 51, 0.035),
      rgba(87, 69, 51, 0.035) 1px,
      transparent 1px,
      transparent 6px
    );
  opacity: 0.44;
}

a {
  color: inherit;
  text-decoration: none;
}

button, input, textarea, select {
  font: inherit;
}

.app-shell {
  position: relative;
  z-index: 1;
  max-width: 1480px;
  margin: 0 auto;
  padding: 22px;
}

.topbar {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr) auto;
  gap: 18px;
  align-items: center;
  padding: 16px 18px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  border-radius: 26px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(18px);
  position: sticky;
  top: 16px;
  z-index: 20;
}

.brand {
  display: grid;
  gap: 6px;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
  font-size: 1.4rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.brand-mark span:last-child {
  color: var(--accent);
}

.brand-meta {
  color: var(--text-soft);
  font-size: 0.84rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.topnav {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}

.topnav a {
  padding: 12px 16px;
  border-radius: 999px;
  border: 1px solid transparent;
  color: var(--text-soft);
  font-size: 0.95rem;
  letter-spacing: 0.02em;
}

.topnav a.active {
  background: var(--surface);
  color: var(--text-on-dark);
  border-color: rgba(255,255,255,0.08);
}

.topnav a:hover {
  border-color: var(--line);
}

.top-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  align-items: center;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.62);
  color: var(--text-soft);
  font-size: 0.84rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.button,
.button-quiet,
.button-danger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 16px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  transition: transform 120ms ease, opacity 120ms ease, box-shadow 120ms ease;
}

.button {
  background: linear-gradient(135deg, var(--accent), #bf7349);
  color: white;
  box-shadow: 0 10px 24px rgba(160, 77, 46, 0.24);
}

.button-quiet {
  background: rgba(255,255,255,0.72);
  color: var(--text);
  border: 1px solid var(--line);
}

.button-danger {
  background: rgba(153, 44, 44, 0.12);
  color: var(--danger);
  border: 1px solid rgba(153, 44, 44, 0.18);
}

.button:hover,
.button-quiet:hover,
.button-danger:hover {
  transform: translateY(-1px);
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.92fr);
  gap: 24px;
  margin-top: 22px;
}

.hero-panel,
.hero-side,
.card,
.panel,
.section-card,
.feed-card,
.library-card,
.rail-card,
.auth-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow);
}

.hero-panel {
  padding: 32px;
  display: grid;
  gap: 24px;
  overflow: hidden;
  position: relative;
}

.hero-panel::after {
  content: "";
  position: absolute;
  inset: auto -70px -90px auto;
  width: 260px;
  height: 260px;
  background: radial-gradient(circle, rgba(15,127,132,0.18), transparent 68%);
  pointer-events: none;
}

.hero-kicker,
.section-kicker,
.eyebrow {
  color: var(--accent);
  font-size: 0.8rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.hero h1,
.page-title,
.doc-title,
.profile-name,
.auth-card h1 {
  margin: 0;
  font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
  line-height: 0.95;
  letter-spacing: -0.03em;
}

.hero h1 {
  font-size: clamp(3rem, 6vw, 5.4rem);
  max-width: 11ch;
}

.hero p,
.lede,
.muted,
.meta-line,
.stat-copy,
.doc-summary,
.thread-meta,
.comment-meta {
  color: var(--text-soft);
}

.query-form {
  display: grid;
  gap: 14px;
}

.query-form textarea,
.query-form input[type="text"],
.auth-card input,
.auth-card textarea,
.collection-form input,
.collection-form textarea,
.composer textarea,
.composer input,
.select-input {
  width: 100%;
  padding: 16px 18px;
  border-radius: 18px;
  border: 1px solid var(--line-strong);
  background: rgba(255,255,255,0.86);
  color: var(--text);
  min-height: 56px;
}

.query-actions,
.inline-actions,
.doc-actions,
.tab-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.metric-grid,
.labs-grid,
.library-grid,
.profile-grid,
.page-grid,
.feed-grid,
.doc-grid,
.assistant-grid {
  display: grid;
  gap: 20px;
}

.metric-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.metric {
  padding: 18px;
  border-radius: var(--radius-lg);
  background: rgba(18, 29, 36, 0.93);
  color: var(--text-on-dark);
  display: grid;
  gap: 8px;
}

.metric strong {
  font-size: 1.8rem;
  font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
}

.hero-side {
  padding: 24px;
  background: linear-gradient(180deg, rgba(18,29,36,0.96), rgba(26,42,52,0.94));
  color: var(--text-on-dark);
  display: grid;
  gap: 16px;
}

.hero-side .pill {
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.72);
  border-color: rgba(255,255,255,0.08);
}

.feed-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 24px;
}

.feed-card,
.section-card,
.library-card,
.rail-card,
.panel,
.auth-card {
  padding: 22px;
}

.feed-card {
  display: grid;
  gap: 18px;
}

.feed-card:hover {
  transform: translateY(-2px);
}

.card-top {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.card-title {
  display: grid;
  gap: 8px;
}

.card-title h3,
.doc-side-title,
.section-card h2,
.rail-card h3,
.library-card h3 {
  margin: 0;
  font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
  line-height: 1.03;
}

.card-meta,
.tag-row,
.mini-list,
.stat-row,
.resource-list,
.thread-list,
.comment-list,
.notes-list,
.collections-list,
.mini-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip,
.stat-chip,
.tag,
.small-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 999px;
  background: rgba(18,29,36,0.06);
  color: var(--text-soft);
  font-size: 0.8rem;
  letter-spacing: 0.04em;
}

.tag {
  text-transform: lowercase;
}

.page-grid {
  grid-template-columns: 1.25fr 0.78fr;
  margin-top: 24px;
  align-items: start;
}

.section-card {
  display: grid;
  gap: 16px;
}

.section-card h2 {
  font-size: 2rem;
}

.list-stack {
  display: grid;
  gap: 14px;
}

.resource-item,
.note-item,
.comment-item,
.thread-item,
.collection-item,
.stat-band {
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(255,255,255,0.68);
  border: 1px solid var(--line);
}

.resource-item:hover,
.thread-item:hover,
.collection-item:hover {
  border-color: rgba(15, 127, 132, 0.25);
}

.doc-grid {
  grid-template-columns: minmax(0, 1.24fr) minmax(320px, 0.76fr);
  gap: 24px;
  margin-top: 24px;
}

.doc-header {
  display: grid;
  gap: 18px;
}

.doc-title {
  font-size: clamp(2.6rem, 4.6vw, 4.3rem);
}

.doc-subhead {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.doc-body {
  display: grid;
  gap: 18px;
}

.doc-article {
  padding: 28px;
  border-radius: 26px;
  border: 1px solid var(--line);
  background: var(--card-strong);
  box-shadow: var(--shadow);
}

.doc-article p,
.doc-article li {
  line-height: 1.7;
}

.doc-article blockquote {
  margin: 0;
  padding: 18px 20px;
  border-left: 3px solid var(--accent);
  background: rgba(160, 77, 46, 0.05);
  border-radius: 0 16px 16px 0;
}

.rail-card {
  position: sticky;
  top: 118px;
  display: grid;
  gap: 16px;
}

.rail-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.rail-tab,
.subtab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
  color: var(--text-soft);
}

.rail-tab.active,
.subtab.active {
  background: var(--surface);
  color: var(--text-on-dark);
  border-color: rgba(255,255,255,0.08);
}

.assistant-grid {
  grid-template-columns: 360px minmax(0, 1fr);
  gap: 24px;
  margin-top: 24px;
}

.thread-list {
  flex-direction: column;
}

.thread-item.active {
  background: rgba(15, 127, 132, 0.08);
  border-color: rgba(15, 127, 132, 0.2);
}

.chat-log {
  display: grid;
  gap: 14px;
}

.chat-bubble {
  padding: 16px 18px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.82);
}

.chat-bubble.user {
  background: rgba(15, 127, 132, 0.09);
  border-color: rgba(15, 127, 132, 0.18);
}

.auth-wrap {
  min-height: calc(100vh - 160px);
  display: grid;
  place-items: center;
}

.auth-card {
  width: min(720px, 100%);
  display: grid;
  gap: 18px;
  padding: 36px;
}

.auth-card h1 {
  font-size: clamp(2.8rem, 5vw, 4.2rem);
}

.split-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.flash {
  padding: 14px 16px;
  border-radius: 16px;
  border: 1px solid rgba(160, 77, 46, 0.18);
  background: rgba(160, 77, 46, 0.08);
  color: var(--accent);
}

.empty-state {
  padding: 26px;
  border-radius: 22px;
  background: rgba(255,255,255,0.76);
  border: 1px dashed var(--line-strong);
  color: var(--text-soft);
}

.footer-note {
  margin-top: 28px;
  padding: 18px 0 10px;
  color: var(--text-soft);
  font-size: 0.85rem;
}

.mono {
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", monospace;
}

@media (max-width: 1120px) {
  .topbar,
  .hero,
  .doc-grid,
  .page-grid,
  .assistant-grid {
    grid-template-columns: 1fr;
  }

  .rail-card {
    position: static;
  }

  .feed-grid,
  .metric-grid,
  .split-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .app-shell {
    padding: 14px;
  }

  .hero-panel,
  .hero-side,
  .feed-card,
  .section-card,
  .library-card,
  .rail-card,
  .doc-article,
  .auth-card {
    padding: 18px;
    border-radius: 20px;
  }

  .topbar {
    border-radius: 20px;
  }

  .hero h1 {
    max-width: none;
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

function viewerBadge(viewer?: Viewer): string {
  if (!viewer) {
    return `<a class="button-quiet" href="/signin">Sign in</a>`;
  }

  return `
    <span class="pill">@${e(viewer.handle)}</span>
    <a class="button-quiet" href="/u/${e(viewer.handle)}">Profile</a>
    <form method="post" action="/auth/signout">
      <button class="button-danger" type="submit">Sign out</button>
    </form>
  `;
}

function topbar(activeNav: string, viewer?: Viewer): string {
  const navItems = [
    ["Explore", "/"],
    ["Assistant", "/assistant"],
    ["Library", "/library"],
    ["Labs", "/labs"],
  ];
  if (viewer) {
    navItems.push(["Profile", `/u/${viewer.handle}`]);
  }

  return `
    <header class="topbar">
      <a class="brand" href="/">
        <div class="brand-mark"><span>Alpha</span><span>book</span></div>
        <div class="brand-meta">Feed, library, assistant, field notes</div>
      </a>
      <nav class="topnav">
        ${navItems
          .map(
            ([label, href]) => `<a href="${href}" class="${activeNav === label ? "active" : ""}">${label}</a>`,
          )
          .join("")}
      </nav>
      <div class="top-actions">${viewerBadge(viewer)}</div>
    </header>
  `;
}

function layout(title: string, activeNav: string, viewer: Viewer | undefined, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${e(title)} · alphabook</title>
    <meta name="description" content="Research feed, assistant, library, and profile surfaces for books and papers." />
    <style>${appCss}</style>
  </head>
  <body>
    <div class="app-shell">
      ${topbar(activeNav, viewer)}
      ${body}
      <div class="footer-note">
        alphabook is a hybrid reading and research surface for books and papers. The current live bundle includes full-text retrieval for Don Quixote and metadata-first cards for the rest of the feed.
      </div>
    </div>
  </body>
</html>`;
}

function renderDocCard(document: DocumentCard, viewer?: Viewer, compact = false): string {
  return `
    <article class="${compact ? "resource-item" : "feed-card"}">
      <div class="card-top">
        <div class="card-title">
          <div class="eyebrow">${e(document.kicker)}</div>
          <h3><a href="/doc/${e(document.id)}">${e(document.title)}</a></h3>
          <div class="meta-line">${e(document.authors.join(", "))} · ${e(document.year)} · ${e(document.venue)}</div>
        </div>
        <div class="mini-metrics">
          <span class="stat-chip">${document.kind}</span>
          <span class="stat-chip">${e(document.fullTextLabel)}</span>
        </div>
      </div>
      <p class="doc-summary">${e(document.summary)}</p>
      <div class="tag-row">
        ${document.tags.map((tag) => `<span class="tag">${e(tag)}</span>`).join("")}
      </div>
      <div class="stat-row">
        <span class="small-chip">likes ${document.stats.likes}</span>
        <span class="small-chip">saves ${document.stats.saves}</span>
        <span class="small-chip">comments ${document.stats.comments}</span>
        <span class="small-chip">${document.liked ? "liked by you" : "open for annotation"}</span>
      </div>
      <div class="doc-actions">
        <a class="button-quiet" href="/doc/${e(document.id)}">Open dossier</a>
        <a class="button-quiet" href="/assistant?docId=${e(document.id)}">Ask assistant</a>
        ${
          viewer
            ? `
            <form method="post" action="/action/save">
              <input type="hidden" name="docId" value="${e(document.id)}" />
              <input type="hidden" name="redirect" value="/doc/${e(document.id)}" />
              <button class="${document.saved ? "button" : "button-quiet"}" type="submit">${document.saved ? "Saved" : "Save"}</button>
            </form>
          `
            : `<a class="button-quiet" href="/signin">Sign in to save</a>`
        }
      </div>
    </article>
  `;
}

function renderSearchPreview(search?: SearchResponse): string {
  if (!search) {
    return "";
  }

  return `
    <section class="section-card">
      <div class="section-kicker">Active retrieval</div>
      <h2>Search routed “${e(search.query)}” into document and chunk evidence.</h2>
      <div class="list-stack">
        ${search.results
          .slice(0, 5)
          .map(
            (result) => `
              <a class="resource-item" href="${e(result.href)}">
                <div class="card-top">
                  <strong>${e(result.title)}</strong>
                  <span class="small-chip">${e(result.strategy)}</span>
                </div>
                <div class="muted">${e(result.excerpt)}</div>
              </a>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

export function renderHomePage(input: {
  viewer?: Viewer;
  activeTab: FeedTab;
  documents: DocumentCard[];
  search?: SearchResponse;
}): string {
  const body = `
    <section class="hero">
      <div class="hero-panel">
        <div class="hero-kicker">Explore feed</div>
        <h1>Research like a working library, not a PDF graveyard.</h1>
        <p class="lede">
          alphabook combines a feed, a dossier reader, a library, and a persistent assistant. Ask broad questions,
          save field notes, then launch slower research loops only when the cheap routing layer says a document matters.
        </p>
        <form class="query-form" method="get" action="/search">
          <textarea name="q" placeholder="Ask or search anything... Try: all the times people are talking about sadness">${e(
            input.search?.query ?? "",
          )}</textarea>
          <div class="query-actions">
            <button class="button" type="submit">Search the corpus</button>
            <a class="button-quiet" href="/assistant">Open assistant</a>
            <a class="button-quiet" href="/labs">Inspect Labs</a>
          </div>
        </form>
        <div class="metric-grid">
          <div class="metric">
            <div class="eyebrow">Surfaces</div>
            <strong>6</strong>
            <div>Feed, document, assistant, library, profile, labs.</div>
          </div>
          <div class="metric">
            <div class="eyebrow">Live corpus</div>
            <strong>2212</strong>
            <div>Don Quixote chunks bundled into the deployed worker.</div>
          </div>
          <div class="metric">
            <div class="eyebrow">Loop model</div>
            <strong>3</strong>
            <div>Fast routing, plain-text evidence, and slow research mode.</div>
          </div>
        </div>
      </div>
      <aside class="hero-side">
        <span class="pill">AlphaXiv-shaped product surface</span>
        <h3 class="doc-side-title">What is live right now</h3>
        <p class="muted">A feed-first reading app for books and papers, with sign-in, persistent library state, notes, comments, profile pages, labs, and an assistant surface.</p>
        <div class="list-stack">
          <div class="resource-item">
            <strong>Feed tabs</strong>
            <div class="muted">Hot, likes, briefs, all sorted with dynamic user signals.</div>
          </div>
          <div class="resource-item">
            <strong>Document dossiers</strong>
            <div class="muted">Document, brief, resources, plus assistant / notes / comments / similar in the rail.</div>
          </div>
          <div class="resource-item">
            <strong>Persistent user state</strong>
            <div class="muted">Cookie auth with collections, saves, comments, notes, and threads stored in a Durable Object.</div>
          </div>
        </div>
      </aside>
    </section>

    <section class="tab-row" style="margin-top:24px;">
      <a class="subtab ${input.activeTab === "hot" ? "active" : ""}" href="/?tab=hot">Hot</a>
      <a class="subtab ${input.activeTab === "likes" ? "active" : ""}" href="/?tab=likes">Likes</a>
      <a class="subtab ${input.activeTab === "briefs" ? "active" : ""}" href="/?tab=briefs">Briefs</a>
    </section>

    ${renderSearchPreview(input.search)}

    <section class="feed-grid">
      ${input.documents.map((document) => renderDocCard(document, input.viewer)).join("")}
    </section>
  `;

  return layout("Explore", "Explore", input.viewer, body);
}

export function renderSearchPage(input: {
  viewer?: Viewer;
  query: string;
  search: SearchResponse;
  feedDocuments: DocumentCard[];
}): string {
  const body = `
    <section class="hero">
      <div class="hero-panel">
        <div class="hero-kicker">Search</div>
        <h1>Search that routes before it reasons.</h1>
        <p class="lede">Use this surface for broad retrieval. The feed stays editorial; search stays operational.</p>
        <form class="query-form" method="get" action="/search">
          <input type="text" name="q" value="${e(input.query)}" placeholder="Search books, papers, and bundled full text" />
          <div class="query-actions">
            <button class="button" type="submit">Run search</button>
            <a class="button-quiet" href="/assistant?prompt=${encodeURIComponent(input.query)}">Send to assistant</a>
          </div>
        </form>
      </div>
      <aside class="hero-side">
        <span class="pill">Search diagnostics</span>
        <h3 class="doc-side-title">Top routing outcomes</h3>
        <div class="list-stack">
          ${input.search.documentHits
            .slice(0, 3)
            .map(
              (hit) => `
                <a class="resource-item" href="${e(hit.href)}">
                  <strong>${e(hit.title)}</strong>
                  <div class="muted">${e(hit.excerpt)}</div>
                </a>
              `,
            )
            .join("")}
        </div>
      </aside>
    </section>

    <section class="page-grid">
      <div class="section-card">
        <div class="section-kicker">Results</div>
        <h2>${input.search.results.length} routed results for “${e(input.query)}”.</h2>
        <div class="list-stack">
          ${input.search.results
            .map(
              (result) => `
                <a class="resource-item" href="${e(result.href)}">
                  <div class="card-top">
                    <strong>${e(result.title)}</strong>
                    <span class="small-chip">${e(result.strategy)}</span>
                  </div>
                  <div class="muted">${e(result.excerpt)}</div>
                </a>
              `,
            )
            .join("")}
        </div>
      </div>
      <aside class="section-card">
        <div class="section-kicker">Suggested next reads</div>
        <h2>Move from search into a saved path.</h2>
        <div class="list-stack">
          ${input.feedDocuments.slice(0, 3).map((document) => renderDocCard(document, input.viewer, true)).join("")}
        </div>
      </aside>
    </section>
  `;
  return layout("Search", "Explore", input.viewer, body);
}

function railNav(documentId: string, panel: RailPanel, view: DocumentView, query?: string): string {
  const link = (label: string, nextPanel: RailPanel) =>
    `<a class="rail-tab ${panel === nextPanel ? "active" : ""}" href="/doc/${e(documentId)}?view=${e(view)}&panel=${nextPanel}${
      query ? `&q=${encodeURIComponent(query)}` : ""
    }">${label}</a>`;

  return `
    <div class="rail-tabs">
      ${link("Assistant", "assistant")}
      ${link("My Notes", "notes")}
      ${link("Comments", "comments")}
      ${link("Similar", "similar")}
    </div>
  `;
}

function viewTabs(documentId: string, view: DocumentView, panel: RailPanel, query?: string): string {
  const link = (label: string, nextView: DocumentView) =>
    `<a class="subtab ${view === nextView ? "active" : ""}" href="/doc/${e(documentId)}?view=${nextView}&panel=${e(panel)}${
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
}): string {
  const doc = input.document;
  const mainBody =
    input.view === "resources"
      ? `
        <div class="list-stack">
          ${doc.resources
            .map(
              (resource) => `
                <a class="resource-item" href="${e(resource.url)}" target="_blank" rel="noreferrer">
                  <div class="card-top">
                    <strong>${e(resource.label)}</strong>
                    <span class="small-chip">${e(resource.kind)}</span>
                  </div>
                  <div class="muted">${e(doc.summary)}</div>
                </a>
              `,
            )
            .join("")}
        </div>
      `
      : `
        <div class="list-stack">
          ${(input.view === "brief" ? [{ title: "Editorial brief", body: doc.brief }, ...input.sections] : input.sections)
            .map(
              (section, index) => `
                <section id="chunk-${index}" class="section-card">
                  <div class="eyebrow">${index === 0 && input.view === "brief" ? "Brief" : "Section"}</div>
                  <h2>${e(section.title)}</h2>
                  <p>${e(section.body)}</p>
                </section>
              `,
            )
            .join("")}
        </div>
      `;

  let railBody = "";
  if (input.panel === "assistant") {
    railBody = `
      <div class="rail-card">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
        <div>
          <div class="section-kicker">Document assistant</div>
          <h3>Ask against this dossier</h3>
          <p class="muted">Use the current reading surface as scope. Full-text retrieval is only live for Don Quixote in the current bundle.</p>
        </div>
        ${
          input.thread && input.thread.messages.length
            ? `<div class="chat-log">
              ${input.thread.messages
                .slice(-4)
                .map(
                  (message) => `
                    <div class="chat-bubble ${message.role}">
                      <div class="eyebrow">${message.role === "user" ? "You" : "Assistant"}</div>
                      <div>${e(message.content)}</div>
                    </div>
                  `,
                )
                .join("")}
            </div>`
            : `<div class="empty-state">No messages yet for this document. Ask for a brief, a comparison, or a slow research pass.</div>`
        }
        <form class="composer" method="post" action="/action/assistant">
          <input type="hidden" name="docId" value="${e(doc.id)}" />
          <input type="hidden" name="redirect" value="/doc/${e(doc.id)}?panel=assistant&view=${input.view}" />
          <textarea name="prompt" placeholder="Ask about motifs, arguments, or similar documents"></textarea>
          <button class="button" type="submit">Send to assistant</button>
        </form>
      </div>
    `;
  } else if (input.panel === "notes") {
    railBody = `
      <div class="rail-card">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
        <div>
          <div class="section-kicker">My notes</div>
          <h3>Capture field notes while reading.</h3>
        </div>
        ${
          input.viewer
            ? `
              <form class="composer" method="post" action="/action/note">
                <input type="hidden" name="docId" value="${e(doc.id)}" />
                <input type="hidden" name="redirect" value="/doc/${e(doc.id)}?panel=notes&view=${input.view}" />
                <input name="anchor" placeholder="Anchor label, e.g. Windmill scene" />
                <textarea name="text" placeholder="Write a private note"></textarea>
                <button class="button" type="submit">Add note</button>
              </form>
            `
            : `<div class="empty-state"><a href="/signin">Sign in</a> to save notes.</div>`
        }
        <div class="list-stack notes-list">
          ${
            input.notes.length
              ? input.notes
                  .map(
                    (note) => `
                      <div class="note-item">
                        <div class="card-top">
                          <strong>${e(note.anchor)}</strong>
                          <span class="small-chip">${e(formatDate(note.createdAt))}</span>
                        </div>
                        <div class="muted">${e(note.text)}</div>
                      </div>
                    `,
                  )
                  .join("")
              : `<div class="empty-state">No notes yet for this document.</div>`
          }
        </div>
      </div>
    `;
  } else if (input.panel === "comments") {
    railBody = `
      <div class="rail-card">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
        <div>
          <div class="section-kicker">Comments</div>
          <h3>Public conversation around the dossier.</h3>
        </div>
        ${
          input.viewer
            ? `
              <form class="composer" method="post" action="/action/comment">
                <input type="hidden" name="docId" value="${e(doc.id)}" />
                <input type="hidden" name="redirect" value="/doc/${e(doc.id)}?panel=comments&view=${input.view}" />
                <textarea name="text" placeholder="Add a public comment"></textarea>
                <button class="button" type="submit">Post comment</button>
              </form>
            `
            : `<div class="empty-state"><a href="/signin">Sign in</a> to join the discussion.</div>`
        }
        <div class="list-stack comment-list">
          ${
            input.comments.length
              ? input.comments
                  .map(
                    (comment) => `
                      <div class="comment-item">
                        <div class="card-top">
                          <strong>${e(comment.userName)}</strong>
                          <span class="small-chip">@${e(comment.handle)}</span>
                        </div>
                        <div class="muted">${e(comment.text)}</div>
                        <div class="comment-meta">${e(formatDate(comment.createdAt))}</div>
                      </div>
                    `,
                  )
                  .join("")
              : `<div class="empty-state">No comments yet.</div>`
          }
        </div>
      </div>
    `;
  } else {
    railBody = `
      <div class="rail-card">
        ${railNav(doc.id, input.panel, input.view, input.search?.query)}
        <div>
          <div class="section-kicker">Similar documents</div>
          <h3>Keep the reading graph open.</h3>
        </div>
        <div class="list-stack">
          ${input.related.map((document) => renderDocCard(document, input.viewer, true)).join("")}
        </div>
      </div>
    `;
  }

  const body = `
    <section class="doc-grid">
      <div class="doc-body">
        <div class="doc-header">
          <div class="eyebrow">${e(doc.kicker)}</div>
          <h1 class="doc-title">${e(doc.title)}</h1>
          <div class="doc-subhead">
            <span class="chip">${e(doc.kind)}</span>
            <span class="chip">${e(doc.authors.join(", "))}</span>
            <span class="chip">${e(doc.year)}</span>
            <span class="chip">${e(doc.venue)}</span>
            <span class="chip">${e(doc.fullTextLabel)}</span>
          </div>
          <p class="doc-summary">${e(doc.summary)}</p>
          <div class="doc-actions">
            <a class="button-quiet" href="/assistant?docId=${e(doc.id)}">Open full assistant</a>
            ${
              doc.resources[0]
                ? `<a class="button-quiet" href="${e(doc.resources[0].url)}" target="_blank" rel="noreferrer">View source</a>`
                : ""
            }
            ${
              input.viewer
                ? `
                  <form method="post" action="/action/like">
                    <input type="hidden" name="docId" value="${e(doc.id)}" />
                    <input type="hidden" name="redirect" value="/doc/${e(doc.id)}?panel=${input.panel}&view=${input.view}" />
                    <button class="${doc.liked ? "button" : "button-quiet"}" type="submit">${doc.liked ? "Liked" : "Like"} · ${doc.stats.likes}</button>
                  </form>
                  <form method="post" action="/action/save">
                    <input type="hidden" name="docId" value="${e(doc.id)}" />
                    <input type="hidden" name="redirect" value="/doc/${e(doc.id)}?panel=${input.panel}&view=${input.view}" />
                    <button class="${doc.saved ? "button" : "button-quiet"}" type="submit">${doc.saved ? "Saved" : "Save"} · ${doc.stats.saves}</button>
                  </form>
                `
                : `<a class="button-quiet" href="/signin">Sign in to save</a>`
            }
          </div>
          ${viewTabs(doc.id, input.view, input.panel, input.search?.query)}
        </div>
        <article class="doc-article">
          ${
            input.search?.query
              ? `<blockquote>Search overlay active for <span class="mono">${e(input.search.query)}</span>. The sections below are prioritized around the routed evidence.</blockquote>`
              : ""
          }
          ${mainBody}
        </article>
      </div>
      ${railBody}
    </section>
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
}): string {
  const body = `
    <section class="hero">
      <div class="hero-panel">
        <div class="hero-kicker">Assistant</div>
        <h1>A persistent research workspace, not a disposable prompt box.</h1>
        <p class="lede">Threads are saved into your account state. Scope a conversation to one document or keep it corpus-wide.</p>
        ${
          input.viewer
            ? `
              <form class="query-form" method="post" action="/action/assistant">
                <input type="hidden" name="redirect" value="/assistant" />
                <div class="split-grid">
                  <select class="select-input" name="docId">
                    <option value="">Entire library / feed</option>
                    ${input.availableDocs
                      .map(
                        (document) =>
                          `<option value="${e(document.id)}" ${
                            input.activeDocId === document.id ? "selected" : ""
                          }>${e(document.title)}</option>`,
                      )
                      .join("")}
                  </select>
                  <input name="threadId" value="${e(input.activeThread?.id ?? "")}" placeholder="Thread id (optional)" />
                </div>
                <textarea name="prompt" placeholder="Ask for a brief, comparison, or slow research pass">${e(
                  input.prompt ?? "",
                )}</textarea>
                <button class="button" type="submit">Send</button>
              </form>
            `
            : `<div class="empty-state"><a href="/signin">Sign in</a> to persist assistant threads.</div>`
        }
      </div>
      <aside class="hero-side">
        <span class="pill">Assistant modes</span>
        <div class="list-stack">
          <div class="resource-item"><strong>Fast</strong><div class="muted">Route via metadata and chunk search.</div></div>
          <div class="resource-item"><strong>Slow</strong><div class="muted">Trigger deeper evidence summaries for documents that matter.</div></div>
          <div class="resource-item"><strong>Scoped</strong><div class="muted">Bind the thread to a specific document from the feed or your library.</div></div>
        </div>
      </aside>
    </section>

    <section class="assistant-grid">
      <aside class="section-card">
        <div class="section-kicker">Threads</div>
        <h2>Saved conversations</h2>
        <div class="thread-list">
          ${
            input.threads.length
              ? input.threads
                  .map(
                    (thread) => `
                      <a class="thread-item ${input.activeThread?.id === thread.id ? "active" : ""}" href="/assistant?threadId=${e(
                        thread.id,
                      )}">
                        <strong>${e(thread.title)}</strong>
                        <div class="thread-meta">${thread.docId ? `Scoped to ${e(thread.docId)}` : "Cross-library"} · ${e(
                          formatDate(thread.updatedAt),
                        )}</div>
                      </a>
                    `,
                  )
                  .join("")
              : `<div class="empty-state">No saved threads yet.</div>`
          }
        </div>
      </aside>
      <div class="section-card">
        <div class="section-kicker">Conversation</div>
        <h2>${e(input.activeThread?.title ?? "Start a new thread")}</h2>
        <div class="chat-log">
          ${
            input.activeThread?.messages.length
              ? input.activeThread.messages
                  .map(
                    (message) => `
                      <div class="chat-bubble ${message.role}">
                        <div class="eyebrow">${message.role === "user" ? "You" : "Assistant"}</div>
                        <div>${e(message.content)}</div>
                        ${
                          message.citations?.length
                            ? `<div class="mini-list" style="margin-top:12px;">
                                ${message.citations
                                  .map(
                                    (citation) => `
                                      <a class="small-chip" href="${e(citation.href)}">${e(citation.label)}</a>
                                    `,
                                  )
                                  .join("")}
                              </div>`
                            : ""
                        }
                      </div>
                    `,
                  )
                  .join("")
              : `<div class="empty-state">No messages yet. Ask for a brief, a reading plan, or a slower research sweep.</div>`
          }
        </div>
      </div>
    </section>
  `;
  return layout("Assistant", "Assistant", input.viewer, body);
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
    <section class="hero">
      <div class="hero-panel">
        <div class="hero-kicker">Library</div>
        <h1>Your saved reading graph.</h1>
        <p class="lede">Save documents from the feed, group them into collections, and carry your notes and assistant threads with you.</p>
        <div class="metric-grid">
          <div class="metric"><div class="eyebrow">Saved</div><strong>${input.savedDocuments.length}</strong><div>Documents in your library.</div></div>
          <div class="metric"><div class="eyebrow">Notes</div><strong>${input.notesCount}</strong><div>Private notes across the library.</div></div>
          <div class="metric"><div class="eyebrow">Threads</div><strong>${input.threadsCount}</strong><div>Assistant conversations saved to your account.</div></div>
        </div>
      </div>
      <aside class="hero-side">
        <span class="pill">Collections</span>
        ${
          input.viewer
            ? `
              <form class="collection-form" method="post" action="/action/collection">
                <input type="hidden" name="redirect" value="/library" />
                <input name="name" placeholder="Create a collection" />
                <button class="button" type="submit">Add collection</button>
              </form>
            `
            : ""
        }
      </aside>
    </section>

    <section class="library-grid" style="grid-template-columns: 1fr 1fr; margin-top:24px;">
      <div class="library-card">
        <div class="section-kicker">Saved documents</div>
        <h3>Library shelf</h3>
        <div class="list-stack">
          ${
            input.savedDocuments.length
              ? input.savedDocuments.map((document) => renderDocCard(document, input.viewer, true)).join("")
              : `<div class="empty-state">Nothing saved yet. Use the feed or search to start a shelf.</div>`
          }
        </div>
      </div>
      <div class="library-card">
        <div class="section-kicker">Recent activity</div>
        <h3>Recently opened dossiers</h3>
        <div class="list-stack">
          ${
            input.recentDocuments.length
              ? input.recentDocuments.map((document) => renderDocCard(document, input.viewer, true)).join("")
              : `<div class="empty-state">Open a document and it will appear here.</div>`
          }
        </div>
      </div>
      <div class="library-card" style="grid-column: 1 / -1;">
        <div class="section-kicker">Collections</div>
        <h3>Working folders</h3>
        <div class="list-stack">
          ${
            input.collections.length
              ? input.collections
                  .map(
                    (collection) => `
                      <div class="collection-item">
                        <div class="card-top">
                          <strong>${e(collection.name)}</strong>
                          <span class="small-chip">${collection.docs.length} docs</span>
                        </div>
                        <div class="mini-list">
                          ${collection.docs.map((document) => `<a class="small-chip" href="/doc/${e(document.id)}">${e(document.title)}</a>`).join("")}
                        </div>
                      </div>
                    `,
                  )
                  .join("")
              : `<div class="empty-state">Default collections are created when you sign up.</div>`
          }
        </div>
      </div>
    </section>
  `;
  return layout("Library", "Library", input.viewer, body);
}

export function renderProfilePage(input: {
  viewer?: Viewer;
  profile: Viewer;
  ownProfile: boolean;
  stats: { saved: number; notes: number; comments: number; collections: number; threads: number };
  collectionNames: string[];
}): string {
  const body = `
    <section class="hero">
      <div class="hero-panel">
        <div class="hero-kicker">Profile</div>
        <h1>${e(input.profile.name)}</h1>
        <p class="lede">@${e(input.profile.handle)} · ${e(input.profile.bio || "Researcher building a personal reading graph.")}</p>
        <div class="tag-row">
          ${
            input.profile.interests.length
              ? input.profile.interests.map((interest) => `<span class="tag">${e(interest)}</span>`).join("")
              : `<span class="tag">no interests configured yet</span>`
          }
        </div>
      </div>
      <aside class="hero-side">
        <span class="pill">Profile stats</span>
        <div class="metric-grid" style="grid-template-columns:1fr;">
          <div class="metric"><div class="eyebrow">Saved</div><strong>${input.stats.saved}</strong><div>Documents in library</div></div>
          <div class="metric"><div class="eyebrow">Notes</div><strong>${input.stats.notes}</strong><div>Private notes stored</div></div>
          <div class="metric"><div class="eyebrow">Comments</div><strong>${input.stats.comments}</strong><div>Public comments posted</div></div>
        </div>
      </aside>
    </section>

    <section class="profile-grid" style="grid-template-columns: 1fr 1fr; margin-top:24px;">
      <div class="section-card">
        <div class="section-kicker">Collections</div>
        <h2>Research folders</h2>
        <div class="list-stack">
          ${
            input.collectionNames.length
              ? input.collectionNames.map((name) => `<div class="resource-item">${e(name)}</div>`).join("")
              : `<div class="empty-state">No public collections yet.</div>`
          }
        </div>
      </div>
      <div class="section-card">
        <div class="section-kicker">Research posture</div>
        <h2>How this reader uses the system</h2>
        <p class="muted">The profile surface is where saved reading, annotations, and assistant history become a visible research identity instead of disappearing into tool logs.</p>
        ${
          input.ownProfile
            ? `
              <form class="composer" method="post" action="/action/profile">
                <input type="hidden" name="redirect" value="/u/${e(input.profile.handle)}" />
                <textarea name="bio" placeholder="Short public bio">${e(input.profile.bio)}</textarea>
                <input name="interests" value="${e(input.profile.interests.join(", "))}" placeholder="comma-separated interests" />
                <button class="button" type="submit">Update profile</button>
              </form>
            `
            : ""
        }
      </div>
    </section>
  `;
  return layout(`${input.profile.name}`, "Profile", input.viewer, body);
}

export function renderLabsPage(input: { viewer?: Viewer; documents: DocumentCard[] }): string {
  const body = `
    <section class="hero">
      <div class="hero-panel">
        <div class="hero-kicker">Labs</div>
        <h1>The experimental wing for retrieval, graphs, and agent loops.</h1>
        <p class="lede">Labs should feel like an instrument panel: unfinished on purpose, but clear about what can become productized.</p>
      </div>
      <aside class="hero-side">
        <span class="pill">Why Labs exists</span>
        <p class="muted">alphaXiv has a Labs surface because serious research products need somewhere to expose experimental views without breaking the core reading loop.</p>
      </aside>
    </section>

    <section class="labs-grid" style="grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top:24px;">
      <div class="section-card">
        <div class="section-kicker">Semantic constellation</div>
        <h2>Document graph</h2>
        <p class="muted">A future canvas view for similarity clusters, saved documents, and assistant entry points. Right now the related-doc graph is precomputed and exposed in the dossier rail.</p>
      </div>
      <div class="section-card">
        <div class="section-kicker">Agent runs</div>
        <h2>Slow loop monitor</h2>
        <p class="muted">Surface launched research jobs, runner type, evidence count, and completion state. The current live product uses the worker-local loop for bundled corpus scans.</p>
      </div>
      <div class="section-card">
        <div class="section-kicker">Brief engine</div>
        <h2>Editorial briefs</h2>
        <p class="muted">Every feed card should be able to collapse into a short brief, then expand into notes, comments, and resources without context loss.</p>
      </div>
      <div class="section-card">
        <div class="section-kicker">Recommended docs</div>
        <h2>What to connect next</h2>
        <div class="list-stack">
          ${input.documents.slice(0, 4).map((document) => renderDocCard(document, input.viewer, true)).join("")}
        </div>
      </div>
    </section>
  `;
  return layout("Labs", "Labs", input.viewer, body);
}

export function renderAuthPage(input: {
  mode: "signin" | "signup";
  error?: string;
  notice?: string;
}): string {
  const isSignUp = input.mode === "signup";
  const body = `
    <div class="auth-wrap">
      <section class="auth-card">
        <div class="hero-kicker">${isSignUp ? "Create account" : "Sign in"}</div>
        <h1>${isSignUp ? "Build a research identity." : "Return to your library."}</h1>
        <p class="lede">This prototype uses cookie auth backed by a Durable Object so saves, threads, notes, and profile state survive page reloads.</p>
        ${input.notice ? `<div class="flash">${e(input.notice)}</div>` : ""}
        ${input.error ? `<div class="flash">${e(input.error)}</div>` : ""}
        <form class="query-form" method="post" action="${isSignUp ? "/auth/signup" : "/auth/signin"}">
          ${isSignUp ? `<input name="name" placeholder="Display name" required />` : ""}
          <input type="email" name="email" placeholder="Email" required />
          <input type="password" name="password" placeholder="Password" required />
          <button class="button" type="submit">${isSignUp ? "Create account" : "Sign in"}</button>
        </form>
        <div class="muted">
          ${
            isSignUp
              ? `Already have an account? <a href="/signin"><strong>Sign in</strong></a>.`
              : `Need an account? <a href="/signup"><strong>Create one</strong></a>.`
          }
        </div>
      </section>
    </div>
  `;
  return layout(isSignUp ? "Sign Up" : "Sign In", "", undefined, body);
}

export function renderOnboardingPage(input: { viewer: Viewer }): string {
  const body = `
    <div class="auth-wrap">
      <section class="auth-card">
        <div class="hero-kicker">Onboarding</div>
        <h1>Shape your feed before you drown in it.</h1>
        <p class="lede">Pick interests so Explore, Similar, and Library can weight the right documents first.</p>
        <form class="query-form" method="post" action="/action/onboarding">
          <input type="hidden" name="redirect" value="/" />
          <textarea name="bio" placeholder="Short profile bio">${e(input.viewer.bio)}</textarea>
          <input name="interests" value="${e(input.viewer.interests.join(", "))}" placeholder="Interests, comma-separated. Example: transformers, melancholy, political theory" />
          <button class="button" type="submit">Save preferences</button>
        </form>
      </section>
    </div>
  `;
  return layout("Onboarding", "", input.viewer, body);
}

export function renderNotFound(viewer?: Viewer): string {
  return layout(
    "Not Found",
    "",
    viewer,
    `<section class="hero"><div class="hero-panel"><div class="hero-kicker">404</div><h1>That route is not in the library.</h1><p class="lede">Try Explore, Search, or Library.</p><div class="inline-actions"><a class="button" href="/">Back to Explore</a></div></div></section>`,
  );
}

