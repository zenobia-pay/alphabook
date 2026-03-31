# Hermes Corpus Research Prompt

Use this prompt template when running Hermes over the DigitalOcean Project Gutenberg mirror for reproducible corpus research.

## Template

```text
You are on a DigitalOcean droplet with a Project Gutenberg mirror at /srv/alphabook/gutenberg.

A user has submitted this research request:

<USER_RESEARCH_PROMPT>
{{USER_PROMPT}}
</USER_RESEARCH_PROMPT>

Your job is to turn that request into a self-contained corpus research run.

Core objective:
Produce:
1. A structured dataset extracted from the Gutenberg mirror.
2. A briefing based on that dataset.
3. A citation index over that dataset.
4. Any lightweight visualizations that materially improve the briefing.

This is a reproducible research run, not a quick grep report.

Run structure:
- Create a timestamped run directory with a run ID under:
  /srv/alphabook/logs/corpus-research/<timestamp>-<run-id>/
- Log your work as you go in that run directory.
- Save all outputs there so the run is inspectable and idempotent.

Required first step:
1. Interpret the user request.
2. Decide the corpus scope for this request.
   - You may use the entire Project Gutenberg mirror if the request truly applies to the full corpus.
   - Only narrow to a subset if a subset is actually relevant and materially improves the quality of the run.
   - If you choose a subset, explicitly state:
     - the chosen subset
     - why it is relevant
     - how you approximated it from the locally available data
   - If you choose the full corpus, state that explicitly and explain why.
   - Save the scope decision and rationale in the manifest and briefing.

Required second step:
3. Decide the dataset schema before extraction.
   - Decide whether quotes/passages should be labeled or structured.
   - Be pragmatic and consistent.
   - At minimum consider fields like:
     - record_id
     - source_file
     - source_title if inferable
     - source_author if inferable
     - source_year_or_period if inferable
     - corpus_scope
     - quote
     - theme_label
     - confidence
     - keyword_hits
     - reasoning
     - notes
   - Briefly justify the schema, then use it consistently.

Extraction requirements:
- Use terminal tools.
- Use ripgrep as the primary search and extraction mechanism over the chosen corpus scope.
- Use multiple query terms, variants, and concept clusters, not just one literal phrase.
- Prefer high recall first, then structure and deduplicate.
- For every candidate hit found by ripgrep, inspect the matched passage and the relevant text immediately before and after it.
- Use reasoning over that local context to determine whether the quote is actually relevant to the user's request.
- Do not keep a quote just because it matched a keyword.
- Extract exact quotes/passages with enough context to stand alone.
- Each extracted quote must include a short reasoning field explaining why it is relevant.
- Record provenance for every extracted item.
- Deduplicate repeated/near-duplicate hits where practical.

Process requirements:
- Avoid long single shell commands that are likely to time out.
- Prefer bounded terminal commands and append progress updates to `run.log` frequently.
- If a search step is large, break it into smaller chunks and persist intermediate files in the run directory.

Analysis requirements:
- Build the structured dataset.
- Build the citation index.
- Build a markdown briefing that explains:
  - the interpreted user request
  - the chosen corpus scope and why
  - extraction method
  - schema
  - main findings/themes
  - caveats, limits, and likely false positives/false negatives
- Build lightweight visualizations if useful.
  - Markdown tables, CSV summaries, JSON summaries, or SVG charts are fine.

Required outputs:
- manifest.json
- run.log
- dataset.jsonl
- dataset.csv
- citation-index.json
- briefing.md
- any visualization artifacts you generate

Manifest must include:
- run_id
- timestamp
- user_prompt
- corpus_root
- chosen_scope
- scope_rationale
- search_strategy_summary
- schema_summary
- output_file_list
- record_counts
- status

Quality bar:
- Do not stop after a tiny sample unless the chosen scope is intentionally tiny and well justified.
- Search the full chosen scope.
- Use exact quotes in the dataset.
- Every kept quote must have a reasoning field explaining relevance.
- Prefer a useful, inspectable dataset over a clever but opaque workflow.

At the end:
- Print the run directory path.
- Print a short summary of:
  - chosen scope
  - record count
  - labels/themes used
  - main output files
```

## Test Case

```text
Find me all the different ways that authors deal with grief in 19th century literature.
```
