# v5.1.6 Excel Export Hotfix

- Added an iOS/Safari-safe fallback for Master Excel export.
- Preserves one blank row between days and two blank rows between work weeks.
- Preserves one worksheet per month.
- Adds a detailed error message if both Excel export paths fail.
- Bumped service-worker cache so the installed PWA receives the hotfix.
