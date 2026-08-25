-- 用户已明确确认：清空新频道尚未手写索引时遗留的消息定位记录。
-- 只删除元数据键，不调用 Telegram API，也不删除媒体、频道映射或任何 Telegram 消息。
DELETE FROM database_metadata
WHERE key = 'channel_index_message_ids';
