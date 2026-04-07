# Hermes Search Prompt

Use this prompt template when running Hermes for a bounded evidence search over the DigitalOcean Project Gutenberg mirror.

## Template

```text
You are on a DigitalOcean droplet with a prepared Project Gutenberg corpus at {{CORPUS_ROOT}}.

The reusable text-only manifest for this corpus lives at {{PRECOMPUTED_INDEX_DIR}}.

Search for evidence related to the following:

<USER_SEARCH_PROMPT>
{{USER_PROMPT}}
</USER_SEARCH_PROMPT>

Effort budget:
- Stop after you keep {{EFFORT}} evidence hits, unless the scoped corpus is exhausted first.
- Interpret effort strictly as the maximum number of kept hits, not as a license for broad open-ended research.

This is a bounded evidence search, not a full corpus research memo.

Core objective:
Produce a compact, inspectable folder of exact evidence chunks that materially relate to the query.

Required first step:
1. Interpret the search request.
2. Decide the corpus scope before any retrieval.
   - You may use the full corpus if the query is broad.
   - Narrow only when a subset clearly improves relevance or speed.
   - Record the chosen_scope and scope_rationale in the manifest before running ripgrep.
3. Decide what should count as a kept evidence hit.
   - A kept hit must materially bear on the query, not merely contain a matching word.
   - Save exact text with enough surrounding context to stand alone.

Search requirements:
- Use terminal tools.
- Use the precomputed text-only manifest as the source of truth for searchable files.
- Derive a scoped TSV of `size_bytes<TAB>absolute_path` entries before searching.
- Use multiple search terms, variants, and concept clusters when that improves recall.
- Inspect local context around each candidate hit before keeping it.
- Do not keep a passage just because it matched a keyword.
- Stop once you have kept {{EFFORT}} good evidence hits.
- Search raw text only. Do not use HTML, RDF, EPUB metadata, or cache artifacts for the main search.
- Do not regenerate corpus metadata or the text manifest.
- Do not run a single raw `rg` over {{CORPUS_ROOT}}.
- Use the provided progress-aware helper:
  - /srv/alphabook/repo/ops/digitalocean/bin/run-ripgrep-progress.sh
- If the scoped TSV exceeds 5000 files, partition it first with:
  - /srv/alphabook/repo/ops/digitalocean/bin/partition-file-list.sh
- Never send more than 5000 files to a single helper call.
- Use helper calls with `--max-total-files 5000` and `--batch-size 500`.
- When invoking repo helpers on this droplet, use repo-root absolute paths under `/srv/alphabook/repo/...`.

Artifact requirements:
- Create a timestamped inner run directory under:
  /srv/alphabook/logs/corpus-search/<timestamp>-<run-id>/
- Log progress in `run.log`.
- Write `manifest.json` with at least:
  - run_id
  - timestamp
  - user_prompt
  - effort
  - corpus_root
  - chosen_scope
  - scope_rationale
  - search_strategy_summary
  - kept_hit_count
  - status
- Save kept evidence chunks in:
  - `hits/`
- Save a lightweight machine-readable index at:
  - `hits/index.json`
- Each kept hit should get its own file in `hits/`, for example `hit-0001.md`.
- Each hit file should include:
  - hit_id
  - source_file
  - source_title if inferable
  - source_author if inferable
  - matched_terms
  - why_this_is_relevant
  - the exact quoted chunk

Quality bar:
- Scope first, then search.
- Prefer exact, representative evidence over lots of weak matches.
- Keep searching until you reach the effort cap or genuinely exhaust the scoped corpus.
- Keep the output inspectable and lightweight.
- Do not spend time building a full synthesis, labels, or a large structured dataset.

At the end:
- Print the inner run directory path.
- Print a short summary of:
  - chosen scope
  - searched file count
  - kept hit count
  - output files
```

## Example

```text
Search for evidence related to the following:

<USER_SEARCH_PROMPT>
how do authors deal with grief
</USER_SEARCH_PROMPT>
```
