CREATE OR REPLACE VIEW corpus_documents AS
SELECT
  w.id AS document_id,
  COALESCE(NULLIF(w.metadata_json->>'sourceAdapter', ''), 'gutenberg') AS source_adapter,
  CASE
    WHEN w.gutenberg_id IS NULL THEN NULL
    ELSE w.gutenberg_id::text
  END AS external_source_id,
  w.title,
  w.language,
  w.release_date,
  w.rights_status,
  w.summary,
  w.metadata_json,
  w.created_at,
  w.updated_at
FROM works w;

CREATE OR REPLACE VIEW corpus_document_files AS
SELECT
  wf.id,
  wf.work_id AS document_id,
  COALESCE(NULLIF(w.metadata_json->>'sourceAdapter', ''), 'gutenberg') AS source_adapter,
  wf.kind,
  wf.r2_key,
  wf.byte_size,
  wf.sha256,
  wf.metadata_json,
  wf.created_at
FROM work_files wf
JOIN works w ON w.id = wf.work_id;

CREATE OR REPLACE VIEW corpus_document_chunks AS
SELECT
  c.id,
  c.work_id AS document_id,
  COALESCE(NULLIF(w.metadata_json->>'sourceAdapter', ''), 'gutenberg') AS source_adapter,
  c.chunk_index,
  c.text,
  c.embedding,
  c.tsv,
  c.r2_key,
  c.metadata_json,
  c.created_at
FROM chunks c
JOIN works w ON w.id = c.work_id;
