# VHFD private CAD storage

This Worker stores only dispatch category, date/time, year and identifiers. It never accepts raw email bodies, patient records or location fields. Existing website administration and the Gmail poller remain responsible for authentication, trusted-sender filtering and cache invalidation.

## Deployment

1. Create a D1 database and apply `schema.sql` once using the D1 console or Wrangler.
2. Deploy `worker.js` as a module Worker. It is self-contained and has no package dependencies.
3. Bind that D1 database to the Worker using binding name `DB`.
4. Add a strong random Worker secret named `CAD_API_TOKEN` (32–256 characters). Configure the same value as `CAD_STORE_TOKEN` in the website's server-side environment. Never expose it through a `NEXT_PUBLIC_` variable or browser code.
5. Set website server variable `CAD_STORE_URL` to the Worker's HTTPS origin (for example, `https://vhfd-cad.example.workers.dev`) and verify an authenticated `snapshot` before switching production reads/writes.
6. Deploy the website with its storage variables configured. Its poll endpoint now requires `Authorization: Bearer <CAD_STORE_TOKEN>` unless an explicit `CRON_SECRET` overrides it. The managed Worker scheduler sends `CAD_API_TOKEN`; those secrets must match. Existing unsigned schedulers receive HTTP 401 after cutover.
7. After the website is verified, set Worker text variable `CAD_POLL_ENABLED` to `true` and add the Cron Trigger `* * * * *`. The Wrangler configuration includes this trigger with polling disabled by default. Cloudflare invokes the existing website Gmail poll every minute; Gmail processing remains on Vercel. The handler skips all work unless explicitly enabled, uses a 55-second request timeout, rejects redirects, and logs only HTTP status or fixed error codes. It never reads or logs response bodies. Verify a scheduled invocation succeeds in Cloudflare logs.

The Worker does not run schema creation on requests. A missing binding/schema or failed database operation returns HTTP 503 with a generic error. Request/response caching is disabled, and there is no permissive CORS policy. The website may cache sanitized public snapshots separately.

The schedule targets only `https://www.villahillsfd.org/api/cad-poll`. It does not depend on the previous external scheduler. Set `CAD_POLL_ENABLED` to `false` to pause ingestion without disabling stored-call reads. If `CRON_SECRET` is added to Vercel later, synchronize it with the Worker token before the next scheduled run.

## Protocol

Use `POST /v1/query` with `Authorization: Bearer <CAD_API_TOKEN>` and `Content-Type: application/json`. Input is `{ "operation": "...", ...parameters }`. The maximum request body is 16 KiB. Success responses contain the raw JSON value shown below, without an envelope.

| Operation | Parameters | Response |
| --- | --- | --- |
| `duplicate` | `gmailMessageId` | boolean |
| `saveCall` | `data` | saved `Call` |
| `snapshot` | `year` | `{latest: Call[], count, year, updatedAt, countComplete}` |
| `log` | `year` | `Call[]` |
| `pollHistory` | optional `limit` (1–100; default 50) | history array |
| `logPollRun` | `data` | null |
| `updateCallNature` | `callId`, `newNature` | null |
| `deleteCall` | `callId` | null |

`saveCall.data` accepts exactly `gmailMessageId`, `dispatchDatetime` (ISO timestamp with timezone), `dispatchDate` (`MM/DD/YYYY`), `dispatchTime` (`HH:MM`), `dispatchNature` and `sourceYear`. `Call` returns `id`, `dispatchDatetime`, `dispatchDate`, `dispatchTime`, `dispatchNature`, `sourceYear` and `createdAt`. Dates are ISO strings where applicable. `sourceYear` must match the local dispatch date year. All dates must be valid calendar dates. The website supplies Chicago-local date/time fields.

Gmail message identifiers and call IDs permit letters, digits, underscores and hyphens, up to 160 characters. The category is limited to 160 characters and cannot include control characters, HTML brackets or email-address delimiters. Unknown payload fields are rejected.

`saveCall` is idempotent by Gmail message ID. Concurrent/repeated delivery returns the original record and original ID; it never overwrites that record. The SQLite batch makes insertion and retrieval atomic. All data values are bound SQL parameters.

`logPollRun.data` accepts optional nonnegative integer fields `checked`, `stored`, `inboxTotal`, `durationMs`, plus an optional sanitized uppercase error-code string `error`. History returns `ranAt`, `checked`, `stored`, `inboxTotal`, `durationMs` and `error`. Do not call this operation for empty successful polls; operational heartbeat belongs in runtime/scheduler logs.

## Historical counts

New databases are incomplete: `snapshot.countComplete` is **false** unless D1 metadata explicitly contains key `count_complete:<year>` with value `true`. There is no metadata-writing API. Keep the public count labeled incomplete during migration/backfill. After a year's historical records are imported and reconciled, an administrator can set that metadata value with a reviewed D1 SQL migration. Changing metadata does not import any records.

Snapshot includes the ten most recent calls across years; its count and annual log use only the requested year. `updatedAt` indicates the snapshot read time, not the last Gmail poll time.

## Verification

Run `node --test cloudflare-cad/tests.mjs` with Node 24. The tests use Node's real SQLite engine with a D1-compatible adapter, exercising the actual schema and Worker HTTP handler. No credentials or network access are needed.

Restore the historical call records separately after the paused Neon database is available. The Worker does not retrieve or erase Neon data, and deployment does not reset the existing database.
