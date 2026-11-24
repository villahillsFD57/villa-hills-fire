# CAD recovery verification

`backfill-cad-2026.cjs` uses the website's existing Gmail reader and strict Chief
Alert/VLHL parser. It scans the Chicago calendar year 2026 up to a fixed run
cutoff, in 30-day windows, following every page. Retained spam and trash are
included. It never changes Gmail labels or read status and prints aggregate
counts, cutoff timestamps, and sanitized diagnostic status.

## Verified recovery — November 24, 2026

The retained-mail inventory contained 53 eligible 2026 dispatches, spanning April
15 through November 19. The public call log matched all 53 by category,
timestamp, local date/time, and year, with zero missing or extra records. D1
contained 53 records and 53 unique Gmail message IDs. The reviewed completeness
and source-audit metadata were then recorded, and the website's `cad-public`
cache tag was invalidated. The public summary returned HTTP 200 with count 53
and `countComplete: true`.

This verification covers the retained Gmail source; the previous Neon archive
was not available for reconciliation. No raw mail, private verification SQL, or
credentials belong in this repository.

## Repeating the inventory

Run a read-only inventory with the existing server Gmail environment:

```sh
node scripts/backfill-cad-2026.cjs --inventory-only --compare-public
```

`--compare-public` compares category, timestamp, local date/time and year against
the public log as a multiset, reporting only matched/missing/extra counts.
Add `--verify-sql=/absolute/private/path/verify.sql` to prepare read-only SQL that
reconciles every accepted Gmail ID and timestamp directly against D1. The file
contains sanitized identifiers/timestamps, is written with mode 0600, and must
stay outside the repository. It contains no email bodies or locations.

Without `--inventory-only`, the script performs idempotent D1 backfill and then
independently verifies each accepted Gmail ID. This mode also requires
`CAD_STORE_URL` and `CAD_STORE_TOKEN`; never print or commit those credentials.
Direct D1 writes need a separate website data-cache invalidation afterward.
The public-log comparison uses the website's current-year log; after 2026,
verify this fixed-year recovery directly against D1 instead.

Neither mode sets historical-completeness metadata. A complete retained-mail
scan cannot prove the existence of deleted messages or manually entered calls
in the previous database. Review those limits before certifying a count.

Run offline checks with Node 24:

```sh
node --test tests/cad-backfill.test.cjs
```
