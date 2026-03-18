ALTER TABLE work_files
  DROP CONSTRAINT IF EXISTS work_files_kind_check;

ALTER TABLE work_files
  ADD CONSTRAINT work_files_kind_check
  CHECK (kind IN ('raw', 'metadata', 'clean', 'chunks', 'book_html'));
