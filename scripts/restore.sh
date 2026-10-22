#!/usr/bin/env bash
# Restore a backup INTO A NEW DATABASE first, check it, then switch. Usage: scripts/restore.sh backups/file.dump [target_db]
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="$1"; TARGET="${2:-spice_erp_restore}"
docker compose exec -T db createdb -U spice "$TARGET"
docker compose exec -T db pg_restore -U spice -d "$TARGET" --no-owner < "$FILE"
docker compose exec -T db psql -U spice -d "$TARGET" -c 'SELECT count(*) AS invoices FROM "SalesInvoices";'
echo "Restored into $TARGET. To use it, point ConnectionStrings__Default at $TARGET (or rename databases) and restart the api."
