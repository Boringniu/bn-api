ALTER TABLE duplicate_deletion_audit
  ADD COLUMN deletion_scope TEXT NOT NULL DEFAULT 'telegram_and_catalog'
  CHECK (deletion_scope IN ('telegram_and_catalog', 'legacy_catalog_only'));
