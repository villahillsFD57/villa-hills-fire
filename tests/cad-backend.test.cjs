const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;

const root = path.resolve(__dirname, '..');
function loadTs(file, mocks = {}, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  const module = { exports: {} };
  const context = vm.createContext({
    exports: module.exports, module, require: (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      throw new Error(`Unexpected test dependency ${id}`);
    },
    process: { env: { CRON_SECRET: 'test-secret', DATABASE_URL: 'postgres://test-only' } },
    console: { info() {}, error() {} }, Date, Intl, AbortSignal, ...globals,
  });
  vm.runInContext(js, context, { filename: file });
  return module.exports;
}
const nextResponse = { NextResponse: { json(value, init) {
  return new Response(JSON.stringify(value), { ...init, headers: {
    'Content-Type': 'application/json', ...init?.headers,
  }});
}}};
const req = (headers = { authorization: 'Bearer test-secret' }, query = '') => ({
  headers: new Headers(headers), nextUrl: new URL(`https://example.test/api/cad-poll${query}`),
});
const email = { id: 'one', from: 'alert@cfmsg.co', subject: 'Chief Alert', body: 'synthetic', received: new Date('2026-11-24T02:00:00Z') };
const parsed = { status: 'ok', dispatchDate: '11/23/2026', dispatchTime: '20:00', dispatchNature: 'TEST', dispatchDatetime: '2026-11-24T02:00:00Z', sourceYear: 2026 };
function pollHarness(overrides = {}) {
  const calls = { duplicate: 0, save: 0, log: 0, ack: [] };
  const handlers = loadTs('app/api/cad-poll/route.ts', {
    'next/server': nextResponse,
    '@/lib/cad/gmail': { fetchDispatchBatch: async () => ({ emails: [], failures: [] }), markAsRead: async id => { calls.ack.push(id); }, ...overrides.gmail },
    '@/lib/cad/parser': { parseDispatchEmail: () => parsed, ...overrides.parser },
    '@/lib/cad/db': {
      isDuplicate: async () => { calls.duplicate++; return false; },
      saveCall: async () => { calls.save++; },
      logPollRun: async () => { calls.log++; }, ...overrides.db,
    },
  }, overrides.globals ?? {});
  return { handlers, calls };
}

test('empty scheduled poll succeeds without any database operations', async () => {
  const { handlers, calls } = pollHarness();
  const response = await handlers.GET(req());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).examined, 0);
  assert.deepEqual(calls, { duplicate: 0, save: 0, log: 0, ack: [] });
});

test('spoofed cron signature does not authenticate; bearer and query secret do', async () => {
  const { handlers } = pollHarness();
  assert.equal((await handlers.GET(req({ 'x-vercel-cron-signature': 'anything' }))).status, 401);
  assert.equal((await handlers.GET(req({}, '?token=test-secret'))).status, 200);
  assert.equal((await handlers.POST(req())).status, 200);
});

test('legacy scheduler remains compatible only before either server secret is configured', async () => {
  const { handlers, calls } = pollHarness({ globals: { process: { env: {} } } });
  assert.equal((await handlers.GET(req({}))).status, 200);
  assert.equal(calls.duplicate + calls.save + calls.log, 0);
});

test('D1 configuration secures polling with its private token and respects an explicit cron secret', async () => {
  const d1 = pollHarness({ globals: { process: { env: { CAD_STORE_TOKEN: 'd1-secret' } } } });
  assert.equal((await d1.handlers.POST(req({}))).status, 401);
  assert.equal((await d1.handlers.POST(req({ authorization: 'Bearer d1-secret' }))).status, 200);
  assert.equal(d1.calls.duplicate + d1.calls.save + d1.calls.log, 0);
  const explicit = pollHarness({ globals: { process: { env: { CAD_STORE_TOKEN: 'd1-secret', CRON_SECRET: 'cron-secret' } } } });
  assert.equal((await explicit.handlers.POST(req({ authorization: 'Bearer d1-secret' }))).status, 401);
  assert.equal((await explicit.handlers.POST(req({ authorization: 'Bearer cron-secret' }))).status, 200);
});

test('database failure leaves current and later mail unacknowledged and stops DB work', async () => {
  let attempts = 0;
  const { handlers, calls } = pollHarness({
    gmail: { fetchDispatchBatch: async () => ({ emails: [email, { ...email, id: 'two' }], failures: [] }) },
    db: { isDuplicate: async () => { attempts++; throw new Error('private connection details'); } },
  });
  const response = await handlers.GET(req());
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.failed, 1);
  assert.equal(data.deferred, 1);
  assert.equal(attempts, 1);
  assert.equal(calls.log, 0);
  assert.deepEqual(calls.ack, []);
  assert.ok(!JSON.stringify(data).includes('private connection details'));
});

test('failed save is retryable; success is acknowledged only after storage', async () => {
  let stored = false;
  const { handlers, calls } = pollHarness({
    gmail: { fetchDispatchBatch: async () => ({ emails: [email], failures: [] }), markAsRead: async () => { assert.equal(stored, true); calls.ack.push(email.id); } },
    db: { saveCall: async () => { stored = true; } },
  });
  assert.equal((await handlers.GET(req())).status, 200);
  assert.deepEqual(calls.ack, ['one']);
  assert.equal(calls.log, 1);
  const broken = pollHarness({
    gmail: { fetchDispatchBatch: async () => ({ emails: [email], failures: [] }) },
    db: { saveCall: async () => { throw new Error('DB down'); } },
  });
  assert.equal((await broken.handlers.GET(req())).status, 503);
  assert.deepEqual(broken.calls.ack, []);
  assert.equal(broken.calls.log, 0);
});

test('intentional parser rejection is acknowledged without database activity', async () => {
  const { handlers, calls } = pollHarness({
    gmail: { fetchDispatchBatch: async () => ({ emails: [email], failures: [] }) },
    parser: { parseDispatchEmail: () => ({ status: 'failed', reason: 'wrong department' }) },
  });
  assert.equal((await handlers.GET(req())).status, 200);
  assert.deepEqual(calls, { duplicate: 0, save: 0, log: 0, ack: ['one'] });
});

test('untrusted search false-positive is checkpointed without storing content or blocking later polls', async () => {
  const { handlers, calls } = pollHarness({
    gmail: { fetchDispatchBatch: async () => ({ emails: [], failures: [{ id: 'rejected', code: 'UNTRUSTED_SENDER' }] }) },
  });
  const response = await handlers.GET(req());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).skipped, 1);
  assert.deepEqual(calls, { duplicate: 0, save: 0, log: 0, ack: ['rejected'] });
});

test('individual fetch failure does not discard successfully fetched messages', async () => {
  const { handlers, calls } = pollHarness({
    gmail: { fetchDispatchBatch: async () => ({ emails: [email], failures: [{ id: 'bad', code: 'GMAIL_TIMEOUT' }] }) },
  });
  const response = await handlers.GET(req());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).processed, 1);
  assert.deepEqual(calls.ack, ['one']);
});

for (const endpoint of ['latest', 'log', 'summary']) {
  test(`${endpoint} read failure is 503 rather than a successful empty result`, async () => {
    const failed = async () => { throw new Error('private DB error'); };
    const route = loadTs(`app/api/cad/${endpoint}/route.ts`, {
      'next/server': nextResponse,
      '@/lib/cad/public-cache': { getCachedCadSnapshot: failed, getCachedCadLog: failed, getCachedCadSummary: failed },
    });
    const response = await route.GET();
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(Array.isArray(data), false);
    assert.ok(!JSON.stringify(data).includes('private DB error'));
  });
}

test('D1 transport is authenticated and never requires or falls back to Neon', async () => {
  const sent = [];
  let invalidations = 0;
  const call = { id: 'stored', dispatchNature: 'TEST' };
  const db = loadTs('lib/cad/db.ts', {
    './cache-tags': { invalidateCadPublicCache() { invalidations++; } },
  }, {
    URL,
    process: { env: { CAD_STORE_URL: 'https://cad.example.test', CAD_STORE_TOKEN: 'server-test-token' } },
    fetch: async (url, options) => {
      sent.push({ url, options, payload: JSON.parse(options.body) });
      const op = JSON.parse(options.body).operation;
      return { ok: true, json: async () => op === 'duplicate' ? true : op === 'saveCall' ? call : null };
    },
  });
  assert.equal(await db.isDuplicate('mail-one'), true);
  await db.saveCall({ gmailMessageId: 'mail-one', ...parsed });
  await db.updateCallNature('stored', 'UPDATED');
  await db.deleteCall('stored');
  assert.equal(invalidations, 3);
  for (const request of sent) {
    assert.equal(String(request.url), 'https://cad.example.test/v1/query');
    assert.equal(request.options.headers.Authorization, 'Bearer server-test-token');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.cache, 'no-store');
  }
  assert.equal(sent[1].payload.data.gmailMessageId, 'mail-one');
});

test('D1 unavailable response stays an error and an unverified annual total stays incomplete', async () => {
  let broken = false;
  const db = loadTs('lib/cad/db.ts', { './cache-tags': { invalidateCadPublicCache() {} } }, {
    URL,
    process: { env: { CAD_STORE_URL: 'https://cad.example.test', CAD_STORE_TOKEN: 'server-test-token' } },
    fetch: async () => ({ ok: !broken, json: async () => ({ latest: [], count: 5, year: 2026, updatedAt: '2026-11-24T02:00:00Z' }) }),
  });
  assert.equal((await db.getPublicCadSnapshot(2026)).countComplete, false);
  broken = true;
  await assert.rejects(db.getPublicCadSnapshot(2026), /CAD_STORE_UNAVAILABLE/);
});

test('shared public cache reuses one DB snapshot for repeated readers and keys by Chicago year', async () => {
  const { unstable_cache } = require('next/cache');
  const entries = new Map();
  globalThis.__incrementalCache = {
    generateCacheKey: async value => value,
    generateSimpleCacheKey: async value => value,
    get: async key => entries.has(key) ? { value: entries.get(key), isStale: false } : null,
    set: async (key, value) => { entries.set(key, value); },
  };
  let count = 0, year = 2026;
  const cache = loadTs('lib/cad/public-cache.ts', {
    'next/cache': { unstable_cache }, './cache-tags': { CAD_PUBLIC_TAG: 'cad-public' },
    './db': {
      currentChicagoYear: () => year,
      getPublicCadSnapshot: async y => { count++; return { latest: [{ id: 'one' }], count: 2, year: y, updatedAt: '2026-11-24T02:00:00Z' }; },
      getCallsForYear: async () => [],
    },
  });
  try {
    assert.equal((await cache.getCachedCadSummary()).count, 2);
    await cache.getCachedCadSnapshot();
    await cache.getCachedCadSummary();
    assert.equal(count, 1);
    year = 2027;
    assert.equal((await cache.getCachedCadSummary()).year, 2027);
    assert.equal(count, 2);
  } finally { delete globalThis.__incrementalCache; }
});

test('public DB failure is throttled in a warm instance and retried after backoff', async () => {
  let count = 0, now = 0;
  class FakeDate extends Date { static now() { return now; } }
  const cache = loadTs('lib/cad/public-cache.ts', {
    'next/cache': { unstable_cache: fn => fn }, './cache-tags': { CAD_PUBLIC_TAG: 'cad-public' },
    './db': {
      currentChicagoYear: () => 2026,
      getPublicCadSnapshot: async () => { count++; throw new Error('unavailable'); },
      getCallsForYear: async () => { count++; return []; },
    },
  }, { Date: FakeDate });
  await assert.rejects(cache.getCachedCadSummary());
  await assert.rejects(cache.getCachedCadSummary());
  await assert.rejects(cache.getCachedCadLog());
  assert.equal(count, 1);
  now = 61_000;
  await assert.rejects(cache.getCachedCadSummary());
  assert.equal(count, 2);
});

test('poll reports only approved diagnostic codes on Gmail failure', async () => {
  for (const [message, expected] of [
    ['GMAIL_AUTH_REVOKED', 'GMAIL_AUTH_REVOKED'],
    ['GMAIL_CREDENTIALS_MISSING', 'GMAIL_CREDENTIALS_MISSING'],
    ['GMAIL_TIMEOUT', 'GMAIL_TIMEOUT'],
    ['GMAIL_HTTP_429', 'GMAIL_HTTP_429'],
    ['private request credentials', 'GMAIL_REQUEST_FAILED'],
  ]) {
    const { handlers, calls } = pollHarness({
      gmail: { fetchDispatchBatch: async () => { throw new Error(message); } },
    });
    const response = await handlers.GET(req());
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.code, expected);
    assert.equal(calls.log, 0);
    assert.ok(!JSON.stringify(result).includes('private request credentials'));
  }
});

test('legacy endpoint uses shared current call and expires active status without another DB query', async () => {
  const dispatchDatetime = '2026-11-24T02:00:00Z';
  let now = new Date(dispatchDatetime).getTime() + 60_000;
  class FakeDate extends Date { static now() { return now; } }
  const legacy = loadTs('app/api/cad/route.ts', {
    'next/server': nextResponse,
    '@/lib/cad/public-cache': { getCachedCadSummary: async () => ({
      latest: { dispatchDatetime, dispatchNature: 'TEST', location: 'must not be published', units: 'private' },
    }) },
  }, { Date: FakeDate });
  const first = await (await legacy.GET()).json();
  assert.deepEqual(first, { incident: { type: 'TEST', receivedAt: dispatchDatetime, location: null, units: null } });
  now += 2 * 60 * 60 * 1000;
  assert.deepEqual(await (await legacy.GET()).json(), { incident: null });
});

test('legacy read failure is 503 and does not claim an empty incident', async () => {
  const route = loadTs('app/api/cad/route.ts', {
    'next/server': nextResponse,
    '@/lib/cad/public-cache': { getCachedCadSummary: async () => { throw new Error('DB private details'); } },
  });
  const response = await route.GET();
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(Object.hasOwn(result, 'incident'), false);
  assert.ok(!JSON.stringify(result).includes('DB private details'));
});

test('retired reset endpoint returns410 without importing any database client', async () => {
  const route = loadTs('app/api/cad-reset/route.ts', { 'next/server': nextResponse });
  assert.equal((await route.GET()).status, 410);
});

test('manual admin calls use Chicago time and the D1 storage interface', async () => {
  const saved = [];
  const route = loadTs('app/api/admin/calls/route.ts', {
    'next/server': nextResponse,
    '@/lib/admin/auth': { isAdminAuthed: async () => true },
    '@/lib/cad/db': { saveCall: async data => { saved.push(data); }, updateCallNature: async () => {}, deleteCall: async () => {} },
  }, { crypto: require('node:crypto').webcrypto });
  const request = data => ({ json: async () => data });
  assert.equal((await route.POST(request({ dispatchDate: '2026-07-01', dispatchTime: '12:00', dispatchNature: 'TEST' }))).status, 200);
  assert.equal(saved[0].dispatchDatetime, '2026-07-01T17:00:00.000Z');
  assert.equal((await route.POST(request({ dispatchDate: '2026-12-01', dispatchTime: '12:00', dispatchNature: 'TEST' }))).status, 200);
  assert.equal(saved[1].dispatchDatetime, '2026-12-01T18:00:00.000Z');
  assert.equal((await route.POST(request({ dispatchDate: '2026-03-08', dispatchTime: '02:30', dispatchNature: 'TEST' }))).status, 400);
  assert.equal(saved.length, 2);
});
