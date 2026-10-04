CREATE TABLE IF NOT EXISTS visits (
  event_id TEXT PRIMARY KEY,
  visited_at INTEGER NOT NULL,
  ip TEXT NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  network TEXT,
  asn INTEGER,
  path TEXT NOT NULL,
  referrer_host TEXT
);
CREATE INDEX IF NOT EXISTS visits_time ON visits(visited_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS visits_country_time ON visits(country, visited_at DESC);
CREATE INDEX IF NOT EXISTS visits_path_time ON visits(path, visited_at DESC);
