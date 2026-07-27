-- 创建媒体表：存储已入库的媒体元数据
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_provider TEXT NOT NULL,
  source_external_id TEXT NOT NULL,
  source_url TEXT,
  title TEXT NOT NULL,
  code TEXT,
  release_date DATE,
  normalized_actors TEXT,
  normalized_tags TEXT,
  raw_tags TEXT,
  metadata TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_provider, source_external_id)
);

-- 创建审核队列表：存储待审核的标签、演员、别名等
CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, -- tag|actor|alias|category
  content TEXT NOT NULL,
  source TEXT,
  source_id INTEGER,
  status TEXT DEFAULT 'pending', -- pending|approved|rejected
  decision_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

-- 创建审核记录表：保存所有审核决策的历史
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  changes TEXT,
  user TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引以优化查询性能
CREATE INDEX IF NOT EXISTS idx_media_source ON media(source_provider, source_external_id);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status, type);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
