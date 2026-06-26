#!/usr/bin/env bash
# Backup SQLite an toàn (dùng .backup, không copy file đang WAL).
# Chạy qua cron Railway hoặc thủ công: bash scripts/backup.sh
set -euo pipefail

DB="${DB_PATH:-/data/dverse.db}"
OUT_DIR="${BACKUP_DIR:-/data/backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
DEST="$OUT_DIR/dverse_$STAMP.db"

# .backup là cách an toàn nhất (online backup API của SQLite)
sqlite3 "$DB" ".backup '$DEST'"
gzip -f "$DEST"
echo "backup: ${DEST}.gz"

# giữ 14 bản gần nhất
ls -1t "$OUT_DIR"/dverse_*.db.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
