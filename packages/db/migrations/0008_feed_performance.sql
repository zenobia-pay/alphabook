CREATE INDEX IF NOT EXISTS idx_analytics_events_book_open_work_id_created_at
  ON analytics_events(event, (properties_json->>'workId'), created_at DESC)
  WHERE properties_json ? 'workId';
