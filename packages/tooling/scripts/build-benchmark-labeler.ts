import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BenchmarkCorpus, QuerySet } from "@alphabook/benchmark-core";

interface ScriptOptions {
  corpusPath: string;
  querySetPath: string;
  outputPath: string;
  candidateLimit: number;
}

interface LabelerCandidate {
  passageId: string;
  documentId: string;
  chunkIndex: number;
  score: number;
  excerpt: string;
  text: string;
  title: string;
  existingGrade: number;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    corpusPath: "",
    querySetPath: "",
    outputPath: "output/benchmark-labeler/index.html",
    candidateLimit: 40,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--corpus":
        options.corpusPath = argv[++index] ?? options.corpusPath;
        break;
      case "--query-set":
        options.querySetPath = argv[++index] ?? options.querySetPath;
        break;
      case "--output":
        options.outputPath = argv[++index] ?? options.outputPath;
        break;
      case "--candidate-limit":
        options.candidateLimit = Number(argv[++index] ?? options.candidateLimit);
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/build-benchmark-labeler.ts --corpus <path> --query-set <path> [--output path] [--candidate-limit 40]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.corpusPath || !options.querySetPath) {
    throw new Error("--corpus and --query-set are required.");
  }

  if (!Number.isFinite(options.candidateLimit) || options.candidateLimit <= 0) {
    throw new Error(`Invalid --candidate-limit value: ${options.candidateLimit}`);
  }

  return options;
}

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8")) as T;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function scorePassage(queryText: string, notes: string | undefined, passageText: string): number {
  const terms = Array.from(new Set([...tokenize(queryText), ...tokenize(notes ?? "")]));
  const haystack = passageText.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function buildLabelerPayload(corpus: BenchmarkCorpus, querySet: QuerySet, candidateLimit: number) {
  const documentsById = new Map(corpus.documents.map((document) => [document.id, document]));

  return {
    generatedAt: new Date().toISOString(),
    corpus: {
      id: corpus.id,
      displayName: corpus.displayName,
      description: corpus.description,
      passageCount: corpus.passages.length,
    },
    querySet: {
      ...querySet,
      queries: querySet.queries.map((query) => {
        const existingLabels = new Map(query.labels.map((label) => [label.passageId, label.grade]));
        const candidates = corpus.passages
          .map((passage) => {
            const document = documentsById.get(passage.documentId);
            const score = scorePassage(query.text, query.notes, `${passage.excerpt}\n${passage.text}`);
            return {
              passageId: passage.id,
              documentId: passage.documentId,
              chunkIndex: passage.chunkIndex,
              score,
              excerpt: passage.excerpt,
              text: passage.text,
              title: document?.title ?? passage.documentId,
              existingGrade: existingLabels.get(passage.id) ?? 0,
            } satisfies LabelerCandidate;
          })
          .sort((left, right) => {
            if (right.existingGrade !== left.existingGrade) {
              return right.existingGrade - left.existingGrade;
            }
            if (right.score !== left.score) {
              return right.score - left.score;
            }
            return left.chunkIndex - right.chunkIndex;
          })
          .slice(0, candidateLimit);

        return {
          ...query,
          candidates,
        };
      }),
    },
  };
}

function renderHtml(payload: ReturnType<typeof buildLabelerPayload>) {
  const serialized = JSON.stringify(payload)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Benchmark Labeler</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f2e8;
        --panel: rgba(255, 252, 247, 0.92);
        --panel-strong: #fffdf9;
        --ink: #1f1b16;
        --muted: #6f6558;
        --line: rgba(77, 60, 39, 0.18);
        --yes: #1d6b43;
        --maybe: #9a6a00;
        --no: #8a2d1d;
        --accent: #264653;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: Georgia, "Iowan Old Style", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(38, 70, 83, 0.12), transparent 24rem),
          radial-gradient(circle at top right, rgba(233, 196, 106, 0.18), transparent 18rem),
          linear-gradient(180deg, #f8f4eb, #f1ebdf 55%, #ece4d6);
      }

      .shell {
        display: grid;
        grid-template-columns: 22rem minmax(0, 1fr);
        min-height: 100vh;
      }

      .sidebar, .main {
        padding: 1.25rem;
      }

      .sidebar {
        border-right: 1px solid var(--line);
        background: rgba(255, 249, 240, 0.75);
        backdrop-filter: blur(10px);
      }

      .main {
        display: grid;
        grid-template-rows: auto auto 1fr auto;
        gap: 1rem;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        box-shadow: 0 20px 40px rgba(60, 45, 28, 0.07);
      }

      .meta, .toolbar, .card, .footer {
        padding: 1rem 1.1rem;
      }

      h1, h2, h3, p {
        margin: 0;
      }

      .small {
        color: var(--muted);
        font-size: 0.92rem;
        line-height: 1.45;
      }

      .query-list {
        display: grid;
        gap: 0.75rem;
        margin-top: 1rem;
      }

      .query-button {
        width: 100%;
        text-align: left;
        border: 1px solid var(--line);
        background: var(--panel-strong);
        border-radius: 14px;
        padding: 0.85rem;
        cursor: pointer;
      }

      .query-button.active {
        border-color: rgba(38, 70, 83, 0.45);
        box-shadow: inset 0 0 0 1px rgba(38, 70, 83, 0.18);
      }

      .query-button .counts {
        margin-top: 0.45rem;
        font-size: 0.85rem;
        color: var(--muted);
      }

      .toolbar {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
      }

      .toolbar-left, .toolbar-right, .actions {
        display: flex;
        gap: 0.6rem;
        flex-wrap: wrap;
        align-items: center;
      }

      button {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 0.72rem 1rem;
        background: #fffdf9;
        color: var(--ink);
        cursor: pointer;
        font: inherit;
      }

      button.primary {
        background: var(--accent);
        color: white;
        border-color: rgba(38, 70, 83, 0.55);
      }

      button.yes { color: white; background: var(--yes); border-color: transparent; }
      button.maybe { color: white; background: var(--maybe); border-color: transparent; }
      button.no { color: white; background: var(--no); border-color: transparent; }

      .status-badges {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        margin-top: 0.75rem;
      }

      .badge {
        border-radius: 999px;
        padding: 0.3rem 0.7rem;
        font-size: 0.82rem;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.7);
      }

      .card {
        display: grid;
        gap: 1rem;
      }

      .passage-header {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: start;
      }

      .passage-text {
        white-space: pre-wrap;
        line-height: 1.65;
        font-size: 1rem;
      }

      .footer {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
        align-items: center;
      }

      .pill-group {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .hint {
        color: var(--muted);
        font-size: 0.88rem;
      }

      @media (max-width: 900px) {
        .shell {
          grid-template-columns: 1fr;
        }
        .sidebar {
          border-right: none;
          border-bottom: 1px solid var(--line);
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <div class="panel meta">
          <h1>Benchmark Labeler</h1>
          <p class="small" id="dataset-meta"></p>
          <div class="status-badges">
            <span class="badge" id="query-summary"></span>
            <span class="badge" id="passage-summary"></span>
          </div>
        </div>
        <div class="query-list" id="query-list"></div>
      </aside>

      <main class="main">
        <section class="panel meta">
          <p class="small" id="query-index"></p>
          <h2 id="query-text"></h2>
          <p class="small" id="query-notes" style="margin-top: 0.6rem;"></p>
          <div class="status-badges">
            <span class="badge" id="progress-badge"></span>
            <span class="badge" id="current-label-badge"></span>
          </div>
        </section>

        <section class="panel toolbar">
          <div class="toolbar-left">
            <button id="prev-query">Previous Query</button>
            <button id="next-query">Next Query</button>
            <button id="prev-passage">Previous Passage</button>
            <button id="next-passage">Next Passage</button>
          </div>
          <div class="toolbar-right">
            <button class="primary" id="export-json">Export JSON</button>
            <button id="clear-storage">Clear Local Save</button>
          </div>
        </section>

        <section class="panel card">
          <div class="passage-header">
            <div>
              <h3 id="passage-title"></h3>
              <p class="small" id="passage-meta" style="margin-top: 0.35rem;"></p>
            </div>
            <div class="pill-group">
              <span class="badge" id="score-badge"></span>
            </div>
          </div>
          <div class="passage-text" id="passage-text"></div>
          <div class="actions">
            <button class="yes" id="mark-yes">Yes (Y)</button>
            <button class="maybe" id="mark-maybe">Maybe (M)</button>
            <button class="no" id="mark-no">No (N)</button>
            <button id="mark-unset">Unset (U)</button>
          </div>
        </section>

        <section class="panel footer">
          <div>
            <p class="hint">Keyboard: <strong>Y</strong> yes, <strong>M</strong> maybe, <strong>N</strong> no, <strong>U</strong> unset, <strong>J/K</strong> next/prev passage, <strong>[/]</strong> prev/next query.</p>
          </div>
          <div class="small" id="save-status"></div>
        </section>
      </main>
    </div>

    <script>
      const payload = ${serialized};
      const storageKey = "benchmark-labeler:" + payload.corpus.id + ":" + payload.querySet.id;
      const baseQuerySet = JSON.parse(JSON.stringify(payload.querySet));
      const savedBundle = (() => {
        try {
          const raw = localStorage.getItem(storageKey);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      })();
      const workingQuerySet = savedBundle && savedBundle.querySet && savedBundle.querySet.id === baseQuerySet.id
        ? savedBundle.querySet
        : baseQuerySet;
      const reviewState = savedBundle && savedBundle.reviewState ? savedBundle.reviewState : {};
      const state = {
        queryIndex: 0,
        passageIndexByQuery: Object.fromEntries(workingQuerySet.queries.map((query) => [query.id, 0])),
      };

      const el = {
        datasetMeta: document.getElementById("dataset-meta"),
        querySummary: document.getElementById("query-summary"),
        passageSummary: document.getElementById("passage-summary"),
        queryList: document.getElementById("query-list"),
        queryIndex: document.getElementById("query-index"),
        queryText: document.getElementById("query-text"),
        queryNotes: document.getElementById("query-notes"),
        progressBadge: document.getElementById("progress-badge"),
        currentLabelBadge: document.getElementById("current-label-badge"),
        passageTitle: document.getElementById("passage-title"),
        passageMeta: document.getElementById("passage-meta"),
        scoreBadge: document.getElementById("score-badge"),
        passageText: document.getElementById("passage-text"),
        saveStatus: document.getElementById("save-status"),
      };

      function save() {
        localStorage.setItem(storageKey, JSON.stringify({
          querySet: workingQuerySet,
          reviewState,
        }));
        el.saveStatus.textContent = "Saved locally at " + new Date().toLocaleTimeString();
      }

      function reviewKey(queryId, passageId) {
        return queryId + "::" + passageId;
      }

      function queryCounts(query) {
        const labels = new Map(query.labels.map((label) => [label.passageId, label.grade]));
        let yes = 0;
        let maybe = 0;
        let no = 0;
        for (const candidate of query.candidates) {
          const grade = labels.get(candidate.passageId) ?? null;
          if (grade === 2) yes += 1;
          else if (grade === 1) maybe += 1;
          else if (reviewState[reviewKey(query.id, candidate.passageId)] === "no") no += 1;
        }
        return { yes, maybe, no };
      }

      function currentQuery() {
        return workingQuerySet.queries[state.queryIndex];
      }

      function currentPassage() {
        const query = currentQuery();
        const passageIndex = state.passageIndexByQuery[query.id] ?? 0;
        return query.candidates[passageIndex];
      }

      function currentGrade(query, passageId) {
        const label = query.labels.find((entry) => entry.passageId === passageId);
        return label ? label.grade : null;
      }

      function setGrade(grade) {
        const query = currentQuery();
        const passage = currentPassage();
        query.labels = query.labels.filter((entry) => entry.passageId !== passage.passageId);
        if (grade === 2 || grade === 1) {
          query.labels.push({ passageId: passage.passageId, grade });
          reviewState[reviewKey(query.id, passage.passageId)] = grade === 2 ? "yes" : "maybe";
        } else if (grade === "no") {
          reviewState[reviewKey(query.id, passage.passageId)] = "no";
        } else {
          delete reviewState[reviewKey(query.id, passage.passageId)];
        }
        save();
        render();
        movePassage(1);
      }

      function movePassage(delta) {
        const query = currentQuery();
        const current = state.passageIndexByQuery[query.id] ?? 0;
        const next = Math.max(0, Math.min(query.candidates.length - 1, current + delta));
        state.passageIndexByQuery[query.id] = next;
        render();
      }

      function moveQuery(delta) {
        state.queryIndex = Math.max(0, Math.min(workingQuerySet.queries.length - 1, state.queryIndex + delta));
        render();
      }

      function exportJson() {
        const blob = new Blob([JSON.stringify(workingQuerySet, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = workingQuerySet.id + ".json";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      }

      function renderQueryList() {
        el.queryList.innerHTML = "";
        workingQuerySet.queries.forEach((query, index) => {
          const button = document.createElement("button");
          button.className = "query-button" + (index === state.queryIndex ? " active" : "");
          const counts = queryCounts(query);
          button.innerHTML = '<strong>' + query.id + '</strong><div style="margin-top:0.35rem;">' + query.text + '</div><div class="counts">Yes ' + counts.yes + ' • Maybe ' + counts.maybe + ' • No ' + counts.no + '</div>';
          button.addEventListener("click", () => {
            state.queryIndex = index;
            render();
          });
          el.queryList.appendChild(button);
        });
      }

      function render() {
        const query = currentQuery();
        const passage = currentPassage();
        const passageIndex = state.passageIndexByQuery[query.id] ?? 0;
        const grade = currentGrade(query, passage.passageId);
        const review = reviewState[reviewKey(query.id, passage.passageId)] ?? null;
        const labeledQueryCount = workingQuerySet.queries.filter((entry) => entry.labels.length > 0).length;
        const counts = queryCounts(query);

        el.datasetMeta.textContent = payload.corpus.displayName + " • " + payload.corpus.passageCount + " passages";
        el.querySummary.textContent = labeledQueryCount + "/" + workingQuerySet.queries.length + " queries touched";
        el.passageSummary.textContent = query.candidates.length + " ranked candidates/query";
        el.queryIndex.textContent = "Query " + (state.queryIndex + 1) + " of " + workingQuerySet.queries.length;
        el.queryText.textContent = query.text;
        el.queryNotes.textContent = query.notes ? "Notes: " + query.notes : "No notes";
        el.progressBadge.textContent = "Passage " + (passageIndex + 1) + " of " + query.candidates.length + " • Yes " + counts.yes + " • Maybe " + counts.maybe + " • No " + counts.no;
        el.currentLabelBadge.textContent = grade === 2 ? "Current: Yes" : grade === 1 ? "Current: Maybe" : review === "no" ? "Current: No" : "Current: Unlabeled";
        el.passageTitle.textContent = passage.title;
        el.passageMeta.textContent = "Passage " + passage.chunkIndex + " • " + passage.passageId;
        el.scoreBadge.textContent = "Rank score " + passage.score;
        el.passageText.textContent = passage.text;
        renderQueryList();
      }

      document.getElementById("prev-query").addEventListener("click", () => moveQuery(-1));
      document.getElementById("next-query").addEventListener("click", () => moveQuery(1));
      document.getElementById("prev-passage").addEventListener("click", () => movePassage(-1));
      document.getElementById("next-passage").addEventListener("click", () => movePassage(1));
      document.getElementById("mark-yes").addEventListener("click", () => setGrade(2));
      document.getElementById("mark-maybe").addEventListener("click", () => setGrade(1));
      document.getElementById("mark-no").addEventListener("click", () => setGrade("no"));
      document.getElementById("mark-unset").addEventListener("click", () => {
        const query = currentQuery();
        const passage = currentPassage();
        query.labels = query.labels.filter((entry) => entry.passageId !== passage.passageId);
        delete reviewState[reviewKey(query.id, passage.passageId)];
        save();
        render();
      });
      document.getElementById("export-json").addEventListener("click", exportJson);
      document.getElementById("clear-storage").addEventListener("click", () => {
        localStorage.removeItem(storageKey);
        location.reload();
      });

      document.addEventListener("keydown", (event) => {
        if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
          return;
        }
        if (event.key === "y" || event.key === "Y") setGrade(2);
        if (event.key === "m" || event.key === "M") setGrade(1);
        if (event.key === "n" || event.key === "N") {
          setGrade("no");
        }
        if (event.key === "u" || event.key === "U") {
          const query = currentQuery();
          const passage = currentPassage();
          query.labels = query.labels.filter((entry) => entry.passageId !== passage.passageId);
          delete reviewState[reviewKey(query.id, passage.passageId)];
          save();
          render();
        }
        if (event.key === "j" || event.key === "J") movePassage(1);
        if (event.key === "k" || event.key === "K") movePassage(-1);
        if (event.key === "]") moveQuery(1);
        if (event.key === "[") moveQuery(-1);
      });

      render();
    </script>
  </body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpus = await loadJson<BenchmarkCorpus>(options.corpusPath);
  const querySet = await loadJson<QuerySet>(options.querySetPath);
  const payload = buildLabelerPayload(corpus, querySet, options.candidateLimit);
  const html = renderHtml(payload);
  const destination = path.resolve(process.cwd(), options.outputPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, html, "utf8");

  process.stdout.write(`${JSON.stringify({
    outputPath: destination,
    corpusId: corpus.id,
    querySetId: querySet.id,
    queryCount: querySet.queries.length,
    candidateLimit: options.candidateLimit,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
