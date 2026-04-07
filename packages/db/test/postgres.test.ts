import test from "node:test";
import assert from "node:assert/strict";

import { translateD1SchemaToPostgresSql, translateSqliteToPostgresSql } from "../src/postgres";

test("translateSqliteToPostgresSql rewrites common D1 JSON helpers", () => {
  const translated = translateSqliteToPostgresSql(`
    SELECT
      json_extract(metadata_json, '$.coverImageKey') AS cover,
      json_group_array(DISTINCT a.name) AS authors_json
    FROM works w
    LEFT JOIN authors a ON TRUE
    WHERE EXISTS (
      SELECT 1
      FROM json_each(COALESCE(json_extract(w.metadata_json, '$.bookshelves'), '[]')) shelf
      WHERE shelf.value = ?
    )
    LIMIT ? OFFSET ?
  `);

  assert.match(translated, /jsonb_extract_path_text\(\(metadata_json\)::jsonb, 'coverImageKey'\)/u);
  assert.match(translated, /json_agg\(DISTINCT a\.name\)/u);
  assert.match(translated, /jsonb_array_elements_text/u);
  assert.match(translated, /\$1/u);
  assert.match(translated, /\$2/u);
  assert.match(translated, /\$3/u);
});

test("translateD1SchemaToPostgresSql strips PRAGMA and keeps table creation", () => {
  const translated = translateD1SchemaToPostgresSql();
  assert.doesNotMatch(translated, /PRAGMA/u);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS users/u);
  assert.match(translated, /CREATE TABLE IF NOT EXISTS works/u);
});
