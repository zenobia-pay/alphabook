# End-to-End Runtime Metrics Guide

This guide is for measuring the assistant end to end against live production runs, with a focus on:

- time to first primary source in the left document
- time to first Codex CLI start on the VM
- time to workspace ready
- total time to completion
- total books mentioned in the document
- total passages mentioned in the document
- total selected workspace books
- total active books in the final answer
- planned parallel shards
- planned frontier works
- estimated true breadth books
- probe books shown
- verified chunks at VM handoff
- verified works at VM handoff
- actual shard runs
- successful shard runs
- reused prior frontier works
- reused prior verified works
- reused prior chunks
- completion mode
- final answer usefulness
- final answer uniqueness
- final answer support for the original question
- final answer open questions count

## 1. Launch a live run

Use the production session cookie from `.dev.vars` and post the same prompt through the real `/chat` API.

```bash
COOKIE=$(python3 - <<'PY'
from pathlib import Path
for line in Path('.dev.vars').read_text().splitlines():
    if line.startswith('ALPHABOOK_API_SESSION_COOKIE='):
        print(line.split('=', 1)[1].strip().strip('"'))
        break
PY
)

PROMPT='Identify and extract from 19th century fiction (1800–1899) the different ways characters deal with grief (bereavement/mourning). Retrieve and categorize examples/passages by coping strategy (e.g., withdrawal/isolation, melancholy/depression, religious consolation, stoicism, denial, anger, revenge, work/duty, caretaking/attachment, memorialization/ritual, substance use, travel/escape, acceptance) across the corpus.'

curl -sS https://api.alpha-book.org/chat \
  -H "Cookie: $COOKIE" \
  -H 'Origin: https://alpha-book.org' \
  -H 'Referer: https://alpha-book.org/?view=assistant' \
  -H 'Sec-Fetch-Site: same-site' \
  -H 'Content-Type: application/json' \
  -d "{\"message\": $(python3 - <<'PY'
import json, os
print(json.dumps(os.environ["PROMPT"]))
PY
)}"
```

To force the same prompt through the current search modes for an apples-to-apples comparison, include `mode`:

```bash
curl -sS https://api.alpha-book.org/chat \
  -H "Cookie: $COOKIE" \
  -H 'Origin: https://alpha-book.org' \
  -H 'Referer: https://alpha-book.org/?view=assistant' \
  -H 'Sec-Fetch-Site: same-site' \
  -H 'Content-Type: application/json' \
  -d "{\"message\": $(python3 - <<'PY'
import json, os
print(json.dumps(os.environ[\"PROMPT\"]))
PY
), \"mode\": \"semantic\"}"
```

Valid modes today are:

- `semantic`
- `comprehensive`

Capture:

- `session.created.session.id`
- `run.started.run.id`

## 2. Query live run timing from the relational store

Use the production `D1_DATABASE_NAME` from `.dev.vars`.

```bash
node --input-type=module <<'JS'
import fs from 'node:fs';
import { createWranglerD1Db } from '@alphabook/db';

const envText = fs.readFileSync('.dev.vars', 'utf8');
const databaseName = envText.match(/^D1_DATABASE_NAME=(.*)$/m)[1].trim().replace(/^"|"$/g, '');
const db = createWranglerD1Db({ databaseName, wranglerConfig: 'ops/cloudflare/resources.toml' });

const sessionIds = [
  'REPLACE_SESSION_ID_1',
  'REPLACE_SESSION_ID_2'
];
const sessionIdList = `(${sessionIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`;

const result = await db.query(`
with run_rows as (
  select id, session_id, status, started_at, completed_at
  from runs
  where session_id in ${sessionIdList}
),
workspace as (
  select tc.run_id,
         min(case when tc.tool_name='create_workspace' then tc.completed_at end) as create_workspace_completed_at,
         min(case when tc.tool_name='run_workspace_task' then tc.started_at end) as run_workspace_task_started_at
  from tool_calls tc
  join run_rows rr on rr.id = tc.run_id
  group by tc.run_id
),
book_counts as (
  select session_id,
         count(distinct json_extract(properties_json, '$.workId')) as distinct_books
  from analytics_events
  where event = 'book_candidate_in_run'
    and session_id in ${sessionIdList}
  group by session_id
)
select rr.session_id,
       rr.id as run_id,
       rr.status,
       rr.started_at,
       rr.completed_at,
       bc.distinct_books,
       cast(round((julianday(workspace.create_workspace_completed_at) - julianday(rr.started_at)) * 86400000) as integer) as time_to_workspace_ready_ms,
       cast(round((julianday(workspace.run_workspace_task_started_at) - julianday(rr.started_at)) * 86400000) as integer) as time_to_first_codex_cli_start_ms,
       cast(round((julianday(coalesce(rr.completed_at, CURRENT_TIMESTAMP)) - julianday(rr.started_at)) * 86400000) as integer) as elapsed_ms
from run_rows rr
left join workspace on workspace.run_id = rr.id
left join book_counts bc on bc.session_id = rr.session_id
order by rr.started_at asc
`);

console.log(JSON.stringify(result.rows, null, 2));
await db.end();
JS
```

This query gives the most reliable scalar timing data today.

## 3. Pull first-primary-source timing and final-answer counts

The canonical source for the remaining metrics is the run raw log.

Use the run details endpoint:

```bash
curl -sS "https://api.alpha-book.org/sessions/SESSION_ID/runs/RUN_ID" \
  -H "Cookie: $COOKIE" \
  -H 'Origin: https://alpha-book.org' \
  -H 'Referer: https://alpha-book.org/?view=assistant' \
  -H 'Sec-Fetch-Site: same-site'
```

Read these fields when present:

- `metrics.timeToFirstPrimarySourceMs`
- `metrics.totalBooksMentioned`
- `metrics.totalPassagesMentioned`
- `metrics.totalSelectedWorkspaceBooks`
- `metrics.totalActiveBooksInFinalAnswer`
- `metrics.plannedParallelShards`
- `metrics.plannedFrontierWorks`
- `metrics.estimatedTrueBreadthBooks`
- `metrics.probeBooksShown`
- `metrics.verifiedChunksAtVmHandoff`
- `metrics.verifiedWorksAtVmHandoff`
- `metrics.actualShardRuns`
- `metrics.successfulShardRuns`
- `metrics.reusedPriorFrontierWorks`
- `metrics.reusedPriorVerifiedWorks`
- `metrics.reusedPriorChunks`
- `metrics.completionMode`
- `metrics.booksMentioned`
- `metrics.selectedWorkspaceBooks`
- `metrics.activeBooksInFinalAnswer`

If a run is still in progress, these may not be present yet. In that case:

- use the relational store for workspace/Codex/start/completion timing
- use the raw log or tool trace for interim book/chunk evidence

## 4. What good looks like

Current priorities, in order:

1. `timeToFirstPrimarySourceMs`
2. `timeToFirstCodexCliStartMs`
3. `timeToCompletionMs`
4. `totalBooksMentioned`
5. `totalPassagesMentioned`
6. `totalSelectedWorkspaceBooks`
7. `totalActiveBooksInFinalAnswer`
8. `verifiedChunksAtVmHandoff`
9. `estimatedTrueBreadthBooks`
10. `actualShardRuns`
11. `successfulShardRuns`
12. `usefulness`
13. `uniqueness`
14. `supportForQuestion`
15. `openQuestionsCount`

Healthy runs should:

- get `create_workspace` done in well under 30s
- start `run_workspace_task` immediately after workspace readiness
- surface multiple books before the VM finishes
- keep the final answer grounded in several active books, not one or two
- not enter the VM with `verifiedChunksAtVmHandoff = 0` on broad corpus runs
- show `estimatedTrueBreadthBooks` materially larger than `probeBooksShown` on broad thematic prompts
- have `successfulShardRuns` close to `plannedParallelShards` when intensity expects parallel fanout
- show non-zero `reusedPrior*` metrics on genuine follow-up sessions

## 5. Run five-at-a-time experiments

For an experiment batch, record:

- code hypothesis
- deployed worker version
- deployed runtime image
- five session ids
- five run ids
- per-run metrics
- per-run answer-quality scores
- per-run completion mode
- min, median, max for each target metric
- completion rate within the chosen deadline

That gives an apples-to-apples comparison across iterations instead of relying on subjective read-throughs of logs.
