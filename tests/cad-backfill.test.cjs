const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverYear, buildVerificationSql, comparePublicRecords } = require('../scripts/backfill-cad-2026.cjs');

const now = Date.parse('2026-01-02T06:00:00Z');
const parsed = { status: 'ok', dispatchDatetime: '2026-01-01T07:00:00Z', dispatchDate: '01/01/2026', dispatchTime: '01:00', dispatchNature: 'TEST', sourceYear: 2026 };
const mail = id => ({ id, subject: 'Chief Alert', body: 'synthetic', received: new Date(parsed.dispatchDatetime) });
const page = (emails, nextPageToken = null) => ({ emails, nextPageToken, rejected: 0, failures: [], examined: emails.length });

test('year recovery traverses every page, includes retained spam/trash, deduplicates and verifies each eligible ID', async () => {
  const records = new Set(['existing']);
  const windows = [];
  const operations = [];
  const reports = [];
  const result = await recoverYear({
    now,
    fetchPage: async window => {
      windows.push(window);
      return window.pageToken ? page([mail('new')]) : page([mail('existing')], 'next');
    },
    parse: () => parsed,
    query: async (operation, params) => {
      operations.push(operation);
      if (operation === 'snapshot') return { count: records.size, countComplete: false };
      if (operation === 'duplicate') return records.has(params.gmailMessageId);
      assert.equal(operation, 'saveCall');
      assert.deepEqual(Object.keys(params.data).sort(), ['gmailMessageId', 'dispatchDatetime', 'dispatchDate', 'dispatchTime', 'dispatchNature', 'sourceYear'].sort());
      records.add(params.data.gmailMessageId);
      return { id: 'saved' };
    },
    report: value => reports.push(value),
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].start, '2026-01-01T06:00:00.000Z');
  assert.equal(windows[0].end, '2026-01-02T06:00:00.000Z');
  assert.equal(windows[0].includeSpamTrash, true);
  assert.equal(result.accepted, 2);
  assert.equal(result.stored, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.verified, 2);
  assert.equal(result.storedYearCount, 2);
  assert.equal(result.countComplete, false);
  assert.equal(result.completenessMetadataChanged, false);
  assert.equal(operations.filter(operation => operation === 'duplicate').length, 4);
  assert.equal(reports.at(-1).phase, 'complete');
});

test('partial Gmail page never advances or claims complete recovery', async () => {
  let writes = 0;
  await assert.rejects(recoverYear({
    now, fetchPage: async () => ({ ...page([mail('partial')], 'next'), failures: ['GMAIL_TIMEOUT'] }),
    parse: () => parsed,
    query: async operation => { if (operation !== 'snapshot') writes++; return { count: 0 }; },
  }), /RECOVERY_PAGE_INCOMPLETE/);
  assert.equal(writes, 0);
});

test('parser rejections and other local years never reach storage', async () => {
  const writes = [];
  const result = await recoverYear({
    now, fetchPage: async () => page([mail('rejected'), mail('other-year')]),
    parse: (_subject, _body, received) => ({ ...parsed, sourceYear: 2025 }),
    query: async operation => { writes.push(operation); return { count: 0, countComplete: false }; },
  });
  assert.equal(result.rejected, 2);
  assert.equal(result.accepted, 0);
  assert.deepEqual(writes, ['snapshot', 'snapshot']);
});

test('missing durable ID fails final verification despite successful save response', async () => {
  await assert.rejects(recoverYear({
    now, fetchPage: async () => page([mail('lost')]), parse: () => parsed,
    query: async operation => operation === 'snapshot' ? { count: 1 } : operation === 'duplicate' ? false : { id: 'saved' },
  }), /RECOVERY_VERIFICATION_FAILED/);
});

test('full year divides into bounded windows with no timezone gap', async () => {
  const windows = [];
  await recoverYear({
    now: Date.parse('2027-02-01T00:00:00Z'),
    fetchPage: async window => { windows.push(window); return page([]); },
    parse: () => parsed, query: async () => ({ count: 0 }),
  });
  assert.equal(windows.length, 13);
  assert.equal(windows[0].start, '2026-01-01T06:00:00.000Z');
  assert.equal(windows.at(-1).end, '2027-01-01T06:00:00.000Z');
  for (let index = 0; index < windows.length; index++) {
    assert.ok(Date.parse(windows[index].end) - Date.parse(windows[index].start) <= 30 * 86400000);
    if (index) assert.equal(windows[index - 1].end, windows[index].start);
  }
});

test('inventory mode requires no storage credentials and never calls storage', async () => {
  const result = await recoverYear({
    now, inventoryOnly: true, fetchPage: async () => page([mail('inventory')]), parse: () => parsed,
    query: async () => { throw new Error('inventory must never access storage'); },
  });
  assert.equal(result.phase, 'inventory-complete');
  assert.equal(result.accepted, 1);
  assert.equal(result.stored, 0);
  assert.equal(result.storageVerified, false);
});

test('generated verification SQL counts exact Gmail IDs and timestamps without changing data', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE cad_calls (gmail_message_id TEXT UNIQUE, dispatch_datetime TEXT, source_year INTEGER)');
    db.prepare('INSERT INTO cad_calls VALUES (?, ?, ?)').run('present', '2026-01-01T07:00:00.000Z', 2026);
    const sql = buildVerificationSql([
      { gmailMessageId: 'present', dispatchDatetime: '2026-01-01T07:00:00Z', sourceYear: 2026 },
      { gmailMessageId: 'missing', dispatchDatetime: '2026-01-02T07:00:00Z', sourceYear: 2026 },
    ]);
    const result = db.prepare(sql.slice(0, sql.indexOf(';') + 1)).get();
    assert.equal(result.expected_records, 2);
    assert.equal(result.matched_records, 1);
    assert.equal(result.matched_timestamp_records, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM cad_calls').get().total, 1);
    assert.ok(!/\b(?:INSERT|UPDATE|DELETE)\b/.test(sql));
  } finally { db.close(); }
});

test('public reconciliation compares category/date/time as a multiset and detects missing or changed records', () => {
  assert.deepEqual(comparePublicRecords([parsed, parsed], [parsed]), {
    expected: 2, publicRecords: 1, matched: 1, missing: 1, extra: 0, exactMatch: false,
  });
  assert.equal(comparePublicRecords([parsed], [{ ...parsed, id: 'public-id', createdAt: 'ignored' }]).exactMatch, true);
  assert.equal(comparePublicRecords([parsed], [{ ...parsed, dispatchNature: 'CHANGED' }]).matched, 0);
});
