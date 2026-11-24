# CAD regression tests

Use Node.js 24 or later and install the project's dependencies with `npm ci`.

Run all offline ticker/poll tests:

```sh
node --experimental-test-module-mocks --test tests/cad-*.test.* cloudflare-cad/tests.mjs
```

The experimental module-mocking flag is required by the Gmail tests. Node may
print module-mocking and TypeScript-loader warnings; they do not indicate test
failures. No test connects to Gmail, Neon or Cloudflare, sends email, or changes live calls.

Coverage includes empty-poll database usage, retryable failed saves, partial Gmail
failures, sender and parser restrictions, authenticated D1 transport, public error responses,
shared snapshot reuse, year rollover, timeout behavior, and both secret-protected
polling and the existing scheduler with no configured secret.
Gmail coverage verifies processed-label checkpoints preserve read state, retry
failed acknowledgments, recover a deleted label, and bound backlog processing.
The Worker tests execute the real schema against Node's SQLite engine.

`cad-backend.test.cjs` runs the installed Next.js `unstable_cache` implementation
against an in-memory incremental-cache adapter. Production cache distribution,
actual credential validity, and scheduler delivery still require deployment
verification.

Run the project type check separately:

```sh
node node_modules/typescript/bin/tsc --noEmit --incremental false
```
