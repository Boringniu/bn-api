CREATE TABLE telegram_update_audit (
  update_id INTEGER PRIMARY KEY,
  update_type TEXT NOT NULL,
  chat_id TEXT,
  message_id INTEGER,
  outcome TEXT NOT NULL,
  detail TEXT,
  received_at TEXT NOT NULL,
  handled_at TEXT
);

CREATE INDEX telegram_update_audit_recent_idx
  ON telegram_update_audit (received_at DESC);

CREATE INDEX telegram_update_audit_channel_idx
  ON telegram_update_audit (chat_id, message_id, received_at DESC);
