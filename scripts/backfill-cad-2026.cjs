/** One-off authorized recovery. No Gmail mutations; never sets count completeness. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const YEAR = 2026;
const YEAR_START = Date.parse('2026-01-01T06:00:00Z');
const YEAR_END = Date.parse('2027-01-01T06:00:00Z');
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function loadSource(relative) {
  const ts = require('typescript');
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const instance = new Module(filename, module);
    instance.filename = filename;
    instance.paths = Module._nodeModulePaths(path.dirname(filename));
    const nativeRequire = instance.require.bind(instance);
    instance.require = id => id.startsWith('.')
      ? load(path.resolve(path.dirname(filename), id.endsWith('.ts') ? id : `${id}.ts`))
      : nativeRequire(id);
    cache.set(filename, instance);
    instance._compile(compiled, filename);
    return instance.exports;
  }
  return load(path.resolve(__dirname, '..', relative));
}

async function parallel(items, work, concurrency = 4) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (index < items.length) await work(items[index++]);
  }));
}

async function recoverYear({ fetchPage, parse, query, inventoryOnly = false, onAccepted = () => {}, report = () => {}, now = Date.now(), retry = operation => operation() }) {
  const end = Math.min(now, YEAR_END);
  if (end <= YEAR_START) throw new Error('RECOVERY_WINDOW_INVALID');
  const totals = { year: YEAR, windows: 0, pages: 0, examined: 0, accepted: 0, stored: 0, duplicates: 0, rejected: 0, verified: 0 };
  const acceptedIds = new Set();
  const before = inventoryOnly ? null : await query('snapshot', { year: YEAR });
  if (before && (!Number.isSafeInteger(before.count) || before.count < 0)) throw new Error('CAD_STORE_INVALID_RESPONSE');
  const duplicate = async gmailMessageId => {
    const result = await retry(() => query('duplicate', { gmailMessageId }));
    if (typeof result !== 'boolean') throw new Error('CAD_STORE_INVALID_RESPONSE');
    return result;
  };
  report({ phase: 'start', mode: inventoryOnly ? 'inventory' : 'backfill', year: YEAR, cutoff: new Date(end).toISOString(), existingCount: before?.count, countComplete: before?.countComplete === true });

  for (let start = YEAR_START; start < end; start += WINDOW_MS) {
    const window = { start: new Date(start).toISOString(), end: new Date(Math.min(start + WINDOW_MS, end)).toISOString(), includeSpamTrash: true };
    let token;
    const tokens = new Set();
    do {
      const page = await retry(async () => {
        const result = await fetchPage({ ...window, ...(token ? { pageToken: token } : {}) }, AbortSignal.timeout(30_000));
        if (result.failures.length) throw new Error('RECOVERY_PAGE_INCOMPLETE');
        return result;
      });
      totals.pages++;
      totals.examined += page.examined;
      totals.rejected += page.rejected;
      await parallel(page.emails, async email => {
        const parsed = parse(email.subject, email.body, email.received);
        if (parsed.status !== 'ok' || parsed.sourceYear !== YEAR) { totals.rejected++; return; }
        if (acceptedIds.has(email.id)) return;
        acceptedIds.add(email.id);
        totals.accepted++;
        onAccepted({ gmailMessageId: email.id, dispatchDatetime: parsed.dispatchDatetime,
          dispatchDate: parsed.dispatchDate, dispatchTime: parsed.dispatchTime,
          dispatchNature: parsed.dispatchNature, sourceYear: parsed.sourceYear });
        if (inventoryOnly) return;
        if (await duplicate(email.id)) { totals.duplicates++; return; }
        await retry(() => query('saveCall', { data: {
          gmailMessageId: email.id, dispatchDatetime: parsed.dispatchDatetime,
          dispatchDate: parsed.dispatchDate, dispatchTime: parsed.dispatchTime,
          dispatchNature: parsed.dispatchNature, sourceYear: parsed.sourceYear,
        } }));
        totals.stored++;
      });
      token = page.nextPageToken;
      if (token && tokens.has(token)) throw new Error('RECOVERY_CURSOR_REPEATED');
      if (token) tokens.add(token);
    } while (token);
    totals.windows++;
    report({ phase: 'progress', ...totals });
  }

  if (inventoryOnly) {
    const result = { phase: 'inventory-complete', ok: true, ...totals,
      retainedMailboxEnumerated: true, storageVerified: false,
      completenessMetadataChanged: false, readStatusChanged: false,
      cutoff: new Date(end).toISOString() };
    report(result);
    return result;
  }

  // Independently confirm every eligible Gmail ID is durably present. Listing
  // count alone is insufficient because concurrent ingestion may add records.
  await parallel([...acceptedIds], async gmailMessageId => {
    if (!(await duplicate(gmailMessageId))) throw new Error('RECOVERY_VERIFICATION_FAILED');
    totals.verified++;
  });
  const after = await query('snapshot', { year: YEAR });
  if (totals.verified !== totals.accepted || !Number.isSafeInteger(after.count) || after.count < totals.verified) {
    throw new Error('RECOVERY_COUNT_MISMATCH');
  }
  const result = {
    phase: 'complete', ok: true, ...totals, storedYearCount: after.count,
    retainedMailboxVerified: true, countComplete: after.countComplete === true,
    completenessMetadataChanged: false, readStatusChanged: false,
    cutoff: new Date(end).toISOString(),
  };
  report(result);
  return result;
}

function buildVerificationSql(records) {
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  if (!records.length) throw new Error('RECOVERY_NO_RECORDS');
  const values = records.map(record => {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(record.gmailMessageId) || record.sourceYear !== YEAR
      || !Number.isFinite(Date.parse(record.dispatchDatetime))) throw new Error('RECOVERY_INVALID_RECORD');
    return `(${quote(record.gmailMessageId)}, ${quote(new Date(record.dispatchDatetime).toISOString())}, ${YEAR})`;
  }).join(',\n');
  return `-- Read-only reconciliation of retained 2026 CAD Gmail alerts. No email bodies or locations.\nWITH expected(gmail_message_id, dispatch_datetime, source_year) AS (VALUES\n${values}\n)\nSELECT COUNT(*) AS expected_records,\n  COUNT(c.gmail_message_id) AS matched_records,\n  SUM(CASE WHEN c.source_year = expected.source_year THEN 1 ELSE 0 END) AS matched_year_records,\n  SUM(CASE WHEN c.dispatch_datetime = expected.dispatch_datetime THEN 1 ELSE 0 END) AS matched_timestamp_records,\n  MIN(expected.dispatch_datetime) AS expected_first, MAX(expected.dispatch_datetime) AS expected_last,\n  MIN(c.dispatch_datetime) AS stored_first, MAX(c.dispatch_datetime) AS stored_last\nFROM expected LEFT JOIN cad_calls c ON c.gmail_message_id = expected.gmail_message_id;\n\nSELECT COUNT(*) AS year_records, COUNT(DISTINCT gmail_message_id) AS unique_gmail_ids\nFROM cad_calls WHERE source_year = ${YEAR};\n`;
}

function comparePublicRecords(records, rows) {
  if (!Array.isArray(rows)) throw new Error('RECOVERY_PUBLIC_LOG_UNAVAILABLE');
  const fingerprint = record => JSON.stringify([
    new Date(record.dispatchDatetime).toISOString(), record.dispatchDate,
    record.dispatchTime, record.dispatchNature, record.sourceYear,
  ]);
  const remaining = new Map();
  for (const row of rows) {
    const key = fingerprint(row);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  let matched = 0;
  for (const record of records) {
    const key = fingerprint(record);
    const count = remaining.get(key) ?? 0;
    if (count > 0) { matched++; remaining.set(key, count - 1); }
  }
  return { expected: records.length, publicRecords: rows.length, matched,
    missing: records.length - matched, extra: rows.length - matched,
    exactMatch: matched === records.length && matched === rows.length };
}

function storageQuery() {
  const origin = process.env.CAD_STORE_URL;
  const token = process.env.CAD_STORE_TOKEN;
  if (!origin || !token) throw new Error('CAD_STORE_NOT_CONFIGURED');
  const url = new URL('/v1/query', origin);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('CAD_STORE_URL_INVALID');
  return async (operation, params) => {
    const response = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, ...params }), redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('CAD_STORE_UNAVAILABLE');
    return response.json();
  };
}

async function main() {
  const { fetchRecoveryPage } = loadSource('lib/cad/gmail-recovery.ts');
  const { parseDispatchEmail } = loadSource('lib/cad/parser.ts');
  const retry = async operation => {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  };
  const inventoryOnly = process.argv.includes('--inventory-only');
  const comparePublic = process.argv.includes('--compare-public');
  const verificationArgument = process.argv.find(argument => argument.startsWith('--verify-sql='));
  const records = [];
  await recoverYear({ fetchPage: fetchRecoveryPage, parse: parseDispatchEmail,
    query: inventoryOnly ? undefined : storageQuery(), inventoryOnly,
    onAccepted: record => { if (verificationArgument || comparePublic) records.push(record); },
    retry, report: data => console.log(JSON.stringify(data)) });
  if (verificationArgument) {
    const filename = verificationArgument.slice('--verify-sql='.length);
    if (!path.isAbsolute(filename)) throw new Error('RECOVERY_OUTPUT_PATH_INVALID');
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, buildVerificationSql(records), { mode: 0o600 });
    console.log(JSON.stringify({ phase: 'verification-prepared', records: records.length, path: filename, readOnlySql: true }));
  }
  if (comparePublic) {
    const response = await fetch('https://www.villahillsfd.org/api/cad/log', { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('RECOVERY_PUBLIC_LOG_UNAVAILABLE');
    console.log(JSON.stringify({ phase: 'public-log-comparison', ...comparePublicRecords(records, await response.json()) }));
  }
}

module.exports = { recoverYear, buildVerificationSql, comparePublicRecords };
if (require.main === module) main().catch(error => {
  const code = /^(?:GMAIL_|RECOVERY_|CAD_STORE_)[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'RECOVERY_INCOMPLETE';
  console.error(JSON.stringify({ phase: 'failed', code, completenessMetadataChanged: false, readStatusChanged: false }));
  process.exitCode = 1;
});
