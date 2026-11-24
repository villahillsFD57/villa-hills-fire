const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
function load(file, mocks, env = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    exports: module.exports, module, require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      throw new Error(`Unexpected dependency ${id}`);
    },
    process: { env }, console: { error() {} }, Date, Intl, AbortSignal,
  }, { filename: file });
  return module.exports;
}
const fixedWindow = { start: '2026-11-18T00:00:00.000Z', end: '2026-11-23T00:00:00.000Z' };
const normalize = value => JSON.parse(JSON.stringify(value));

function helperHarness(messages, responses) {
  const calls = { list: [], get: [] };
  const client = { users: { messages: {
    list: async (args, opts) => {
      calls.list.push({ args, opts });
      return { data: { messages, nextPageToken: 'next-page' } };
    },
    get: async ({ id }, opts) => {
      calls.get.push({ id, opts });
      const value = responses[id];
      if (value instanceof Error) throw value;
      return value;
    },
    modify: () => assert.fail('Recovery must not modify mailbox labels'),
  } } };
  const helper = load('lib/cad/gmail-recovery.ts', {
    './gmail': {
      getGmailClient: () => client,
      requestErrorCode: () => 'GMAIL_REQUEST_FAILED',
      extractPlainText: payload => payload.body.text,
    },
  }, { GMAIL_USER: 'cad@example.test', GMAIL_SEARCH_QUERY: 'deliberately ignored' });
  return { ...helper, calls };
}
function message(time, from = 'Chief Dispatch <alert@cfmsg.co>') {
  return { data: { internalDate: String(Date.parse(time)), payload: {
    headers: [{ name: 'FROM', value: from }, { name: 'subject', value: 'Chief Alert' }],
    body: { text: 'synthetic fixture only' },
  } } };
}

test('recovery requires bounded, explicit timestamps and rejects invalid cursors', () => {
  const { validateRecoveryWindow } = helperHarness([], {});
  const now = Date.parse('2026-11-24T00:00:00Z');
  assert.deepEqual(normalize(validateRecoveryWindow(fixedWindow, now)), fixedWindow);
  assert.equal(validateRecoveryWindow({ start: '2026-11-18', end: '2026-11-23' }, now), null);
  assert.equal(validateRecoveryWindow({ ...fixedWindow, end: '2026-12-25T00:00:00Z' }, now), null);
  assert.equal(validateRecoveryWindow({ ...fixedWindow, start: '2026-01-01T00:00:00Z' }, now), null);
  assert.equal(validateRecoveryWindow({ start: '2026-02-30T00:00:00Z', end: '2026-03-02T00:00:00Z' }, now), null);
  assert.equal(validateRecoveryWindow({ ...fixedWindow, start: '2026-11-18T24:00:00Z' }, now), null);
  assert.equal(validateRecoveryWindow({ ...fixedWindow, pageToken: 'x\nheader' }, now), null);
  assert.equal(validateRecoveryWindow({ ...fixedWindow, pageToken: 'x'.repeat(4097) }, now), null);
});

test('recovery ignores read state, uses fixed sender/date query and returns bounded page', async () => {
  const { fetchRecoveryPage, calls } = helperHarness([{ id: 'read-message' }], {
    'read-message': message('2026-11-20T12:00:00Z'),
  });
  const result = await fetchRecoveryPage({ ...fixedWindow, pageToken: 'cursor-1' });
  assert.equal(result.emails[0].id, 'read-message');
  assert.equal(result.nextPageToken, 'next-page');
  assert.equal(calls.list[0].args.maxResults, 20);
  assert.equal(calls.list[0].args.pageToken, 'cursor-1');
  assert.doesNotMatch(calls.list[0].args.q, /is:unread|deliberately ignored/);
  assert.match(calls.list[0].args.q, /from:alert@cfmsg\.co/);
  assert.match(calls.list[0].args.q, /after:\d+ before:\d+/);
  assert.equal(calls.get[0].opts.timeout, 5000);
});

test('untrusted and out-of-window messages are rejected; one fetch failure does not discard good mail', async () => {
  const ids = ['good', 'untrusted', 'before', 'end', 'failed'];
  const { fetchRecoveryPage } = helperHarness(ids.map(id => ({ id })), {
    good: message('2026-11-20T12:00:00Z'),
    untrusted: message('2026-11-20T12:00:00Z', 'untrusted@example.test'),
    before: message('2026-11-17T23:59:59Z'),
    end: message(fixedWindow.end),
    failed: new Error('private request details'),
  });
  const page = await fetchRecoveryPage(fixedWindow);
  assert.deepEqual(normalize(page.emails.map(email => email.id)), ['good']);
  assert.equal(page.rejected, 3);
  assert.deepEqual(normalize(page.failures), ['GMAIL_REQUEST_FAILED']);
});

const nextResponse = { NextResponse: { json(value, init) {
  return new Response(JSON.stringify(value), { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
} } };
function routeHarness(overrides = {}) {
  const calls = { fetch: 0, duplicate: [], saved: [] };
  const email = { id: 'message-one', subject: 'Chief Alert', body: 'synthetic fixture', received: new Date('2026-11-20T12:00:00Z') };
  const { validateRecoveryWindow } = helperHarness([], {});
  const route = load('app/api/admin/calls/recover/route.ts', {
    'next/server': nextResponse,
    '@/lib/admin/auth': { isAdminAuthed: async () => overrides.authed !== false },
    '@/lib/cad/gmail-recovery': {
      validateRecoveryWindow,
      fetchRecoveryPage: async () => {
        calls.fetch++;
        return { emails: [email], examined: 1, rejected: 0, failures: [], nextPageToken: 'next-page', ...overrides.page };
      },
    },
    '@/lib/cad/parser': { parseDispatchEmail: () => ({
      status: 'ok', dispatchDatetime: '2026-11-20T12:00:00Z', dispatchDate: '11/20/2026', dispatchTime: '06:00', dispatchNature: 'TEST', sourceYear: 2026,
    }) },
    '@/lib/cad/db': {
      isDuplicate: async id => { calls.duplicate.push(id); return overrides.duplicate ?? false; },
      saveCall: async data => { if (overrides.saveFails) throw new Error('private database details'); calls.saved.push(data.gmailMessageId); },
    },
  });
  return { ...route, calls };
}
const req = body => ({ json: async () => body });

test('unauthorized or invalid recovery performs no Gmail or database work', async () => {
  const unauthorized = routeHarness({ authed: false });
  assert.equal((await unauthorized.POST(req(fixedWindow))).status, 401);
  assert.equal(unauthorized.calls.fetch, 0);
  const invalid = routeHarness();
  assert.equal((await invalid.POST(req({ start: 'bad' }))).status, 400);
  assert.equal(invalid.calls.fetch, 0);
});

test('recovery deduplicates existing dispatches and never certifies full history', async () => {
  const { POST, calls } = routeHarness({ duplicate: true, page: { nextPageToken: null } });
  const response = await POST(req(fixedWindow));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.duplicates, 1);
  assert.equal(result.recoveryWindowComplete, true);
  assert.equal(result.historyComplete, false);
  assert.equal(calls.saved.length, 0);
});

test('failed storage never advances cursor; retry saves once and advances only on complete page', async () => {
  const failed = routeHarness({ saveFails: true });
  const response = await failed.POST(req({ ...fixedWindow, pageToken: 'current-page' }));
  const result = await response.json();
  assert.equal(response.status, 503);
  assert.equal(result.retryCurrentPage, true);
  assert.equal(result.retryPageToken, 'current-page');
  assert.equal(result.nextPageToken, null);
  assert.equal(result.recoveryWindowComplete, false);
  assert.doesNotMatch(JSON.stringify(result), /private database details|synthetic fixture|message-one/);
  const retried = routeHarness();
  const success = await (await retried.POST(req({ ...fixedWindow, pageToken: 'current-page' }))).json();
  assert.equal(success.stored, 1);
  assert.equal(success.nextPageToken, 'next-page');
});

test('partial fetch failure preserves successful writes but requires retrying the same page', async () => {
  const { POST, calls } = routeHarness({ page: { failures: ['GMAIL_TIMEOUT'], examined: 2 } });
  const response = await POST(req(fixedWindow));
  const result = await response.json();
  assert.equal(response.status, 503);
  assert.equal(result.stored, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.nextPageToken, null);
  assert.equal(result.retryCurrentPage, true);
  assert.deepEqual(calls.saved, ['message-one']);
});
