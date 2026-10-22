#!/usr/bin/env bash
# Daily PostgreSQL backup (schedule with cron: 0 2 * * * /path/scripts/backup.sh)
# Keeps 30 days. Copy the backups folder off the server (e.g. to cloud storage) as well.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
FILE="backups/spice_erp_$(date +%Y%m%d_%H%M%S).dump"
docker compose exec -T db pg_dump -U spice -d spice_erp -Fc > "$FILE"
docker compose exec -T db pg_restore --list < "$FILE" > /dev/null   # verifies the archive is readable
docker compose cp api:/data/uploads "backups/uploads_$(date +%Y%m%d)" 2>/dev/null || true
find backups -name 'spice_erp_*.dump' -mtime +30 -delete
echo "Backup written: $FILE"
