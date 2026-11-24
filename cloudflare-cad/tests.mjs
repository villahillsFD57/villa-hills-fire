import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "./worker.js";

const TOKEN = "offline-test-token-that-is-at-least-32-characters";
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

function store(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  t.after(() => sqlite.close());
  let queryCount = 0;
  class Statement {
    constructor(sql, bindings = []) { this.sql = sql; this.bindings = bindings; }
    bind(...bindings) { return new Statement(this.sql, bindings); }
    async first() { queryCount++; return sqlite.prepare(this.sql).get(...this.bindings) ?? null; }
    async all() { queryCount++; return { success: true, results: sqlite.prepare(this.sql).all(...this.bindings) }; }
    async run() { queryCount++; return { success: true, meta: sqlite.prepare(this.sql).run(...this.bindings) }; }
  }
  const DB = {
    prepare: sql => new Statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const values = [];
        for (const statement of statements) values.push(await statement.all());
        sqlite.exec("COMMIT");
        return values;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return { sqlite, DB, get queryCount() { return queryCount; } };
}

async function invoke(db, input, headers = {}) {
  const request = new Request("https://cad.example.test/v1/query", {
    method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...headers,
    }, body: JSON.stringify(input),
  });
  const response = await worker.fetch(request, { DB: db, CAD_API_TOKEN: TOKEN });
  return { response, value: await response.json() };
}

function call(overrides = {}) {
  return {
    gmailMessageId: "fixture-1", dispatchDatetime: "2026-11-24T02:30:00Z",
    dispatchDate: "11/23/2026", dispatchTime: "20:30", dispatchNature: "WIRES DOWN", sourceYear: 2026,
    ...overrides,
  };
}

test("private endpoints reject absent and wrong bearer token before any SQL", async t => {
  const db = store(t);
  for (const token of ["", "Bearer wrong", `bearer ${TOKEN}`, `Bearer ${TOKEN}suffix`]) {
    const { response, value } = await invoke(db.DB, { operation: "snapshot", year: 2026 }, { Authorization: token });
    assert.equal(response.status, 401);
    assert.deepEqual(value, { error: "UNAUTHORIZED" });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(db.queryCount, 0);
});

test("empty snapshot is explicitly incomplete rather than a verified annual zero", async t => {
  const db = store(t);
  const { response, value } = await invoke(db.DB, { operation: "snapshot", year: 2026 });
  assert.equal(response.status, 200);
  assert.deepEqual({ ...value, updatedAt: "read-time" }, {
    latest: [], count: 0, year: 2026, updatedAt: "read-time", countComplete: false,
  });
  assert.ok(Number.isFinite(Date.parse(value.updatedAt)));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("repeated Gmail delivery preserves original ID and data without duplicates", async t => {
  const db = store(t);
  assert.equal((await invoke(db.DB, { operation: "duplicate", gmailMessageId: "fixture-1" })).value, false);
  const original = await invoke(db.DB, { operation: "saveCall", data: call() });
  const replay = await invoke(db.DB, { operation: "saveCall", data: call({ dispatchNature: "CHANGED REPLAY" }) });
  assert.equal(original.response.status, 200);
  assert.deepEqual(replay.value, original.value);
  assert.equal(replay.value.dispatchDatetime, "2026-11-24T02:30:00.000Z");
  assert.ok(Number.isFinite(Date.parse(replay.value.createdAt)));
  assert.equal((await invoke(db.DB, { operation: "duplicate", gmailMessageId: "fixture-1" })).value, true);
  assert.equal((await invoke(db.DB, { operation: "log", year: 2026 })).value.length, 1);
});

test("snapshot latest crosses years but count/log use only the requested year", async t => {
  const db = store(t);
  await invoke(db.DB, { operation: "saveCall", data: call() });
  await invoke(db.DB, { operation: "saveCall", data: call({
    gmailMessageId: "next-year", dispatchDatetime: "2027-01-01T07:00:00Z",
    dispatchDate: "01/01/2027", dispatchTime: "01:00", sourceYear: 2027,
  }) });
  const { value } = await invoke(db.DB, { operation: "snapshot", year: 2026 });
  assert.equal(value.latest.length, 2);
  assert.equal(value.latest[0].sourceYear, 2027);
  assert.equal(value.count, 1);
  assert.equal(value.countComplete, false);
  db.sqlite.prepare("INSERT INTO cad_metadata (key, value) VALUES (?, ?)").run("count_complete:2026", "true");
  assert.equal((await invoke(db.DB, { operation: "snapshot", year: 2026 })).value.countComplete, true);
  assert.equal((await invoke(db.DB, { operation: "snapshot", year: 2027 })).value.countComplete, false);
});

test("bound values cannot execute SQL and updates/deletes target only their record", async t => {
  const db = store(t);
  const first = (await invoke(db.DB, { operation: "saveCall", data: call() })).value;
  await invoke(db.DB, { operation: "saveCall", data: call({ gmailMessageId: "second" }) });
  const label = "TEST'); DELETE FROM cad_calls; --";
  assert.equal((await invoke(db.DB, { operation: "updateCallNature", callId: first.id, newNature: label })).response.status, 200);
  const log = (await invoke(db.DB, { operation: "log", year: 2026 })).value;
  assert.equal(log.length, 2);
  assert.equal(log.find(row => row.id === first.id).dispatchNature, label);
  assert.equal((await invoke(db.DB, { operation: "deleteCall", callId: first.id })).value, null);
  assert.equal((await invoke(db.DB, { operation: "log", year: 2026 })).value.length, 1);
});

test("invalid fields, calendar dates, years, and unknown operations never reach storage", async t => {
  const db = store(t);
  const invalid = [
    { operation: "saveCall", data: call({ body: "raw email is prohibited" }) },
    { operation: "saveCall", data: call({ dispatchDate: "02/30/2026" }) },
    { operation: "saveCall", data: call({ dispatchDatetime: "2026-02-30T02:30:00Z" }) },
    { operation: "saveCall", data: call({ dispatchTime: "24:10" }) },
    { operation: "saveCall", data: call({ sourceYear: 2025 }) },
    { operation: "saveCall", data: call({ dispatchNature: "x".repeat(161) }) },
    { operation: "saveCall", data: call({ dispatchNature: "PRIVATE\nBODY" }) },
    { operation: "snapshot", year: "2026" },
    { operation: "snapshot", year: 2026, countComplete: true },
    { operation: "pollHistory", limit: 101 },
    { operation: "arbitrarySQL", sql: "DELETE FROM cad_calls" },
  ];
  for (const input of invalid) assert.equal((await invoke(db.DB, input)).response.status, 400);
  assert.equal(db.queryCount, 0);
});

test("poll diagnostics are bounded sanitized codes and preserve nullable counters", async t => {
  const db = store(t);
  assert.equal((await invoke(db.DB, { operation: "logPollRun", data: {
    checked: 3, stored: 2, durationMs: 52, error: "GMAIL_TIMEOUT",
  } })).value, null);
  const { value } = await invoke(db.DB, { operation: "pollHistory", limit: 1 });
  assert.deepEqual({ ...value[0], ranAt: "time" }, {
    ranAt: "time", checked: 3, stored: 2, inboxTotal: null, durationMs: 52, error: "GMAIL_TIMEOUT",
  });
  assert.equal((await invoke(db.DB, { operation: "logPollRun", data: { error: "OAuth detail person@example.test" } })).response.status, 400);
  assert.equal((await invoke(db.DB, { operation: "logPollRun", data: { checked: -1 } })).response.status, 400);
});

test("oversized body and invalid JSON are rejected with generic errors", async t => {
  const db = store(t);
  const { response } = await invoke(db.DB, { operation: "saveCall", data: "x".repeat(17000) });
  assert.equal(response.status, 413);
  const invalid = new Request("https://cad.example.test/v1/query", {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: "{",
  });
  const result = await worker.fetch(invalid, { DB: db.DB, CAD_API_TOKEN: TOKEN });
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), { error: "INVALID_JSON" });
  assert.equal(db.queryCount, 0);
});

test("database failure returns 503 without exposing database exception details", async () => {
  const DB = { prepare() { throw new Error("private database contents must not appear"); } };
  const { response, value } = await invoke(DB, { operation: "duplicate", gmailMessageId: "fixture-1" });
  assert.equal(response.status, 503);
  assert.deepEqual(value, { error: "SERVICE_UNAVAILABLE" });
});

function scheduledEnvironment(overrides = {}) {
  return {
    CAD_API_TOKEN: TOKEN,
    CAD_POLL_ENABLED: "true",
    get DB() { assert.fail("Scheduled polling must not access D1"); },
    ...overrides,
  };
}

test("scheduled polling is disabled unless explicitly enabled with the exact true string", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => assert.fail("Disabled scheduler must not fetch"));
  const info = t.mock.method(console, "info", () => {});
  const error = t.mock.method(console, "error", () => {});
  for (const enabled of [undefined, "false", false, true, "TRUE", ""]) {
    await worker.scheduled({}, scheduledEnvironment({ CAD_POLL_ENABLED: enabled }));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(info.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});

test("enabled scheduler posts only to the fixed poll endpoint with bounded timeout and no redirects", async t => {
  const signal = new AbortController().signal;
  const timeout = t.mock.method(AbortSignal, "timeout", milliseconds => {
    assert.equal(milliseconds, 55_000);
    return signal;
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://www.villahillsfd.org/api/cad-poll");
    assert.equal(options.method, "POST");
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(options.redirect, "manual");
    assert.equal(options.signal, signal);
    return {
      ok: true, status: 200,
      get body() { assert.fail("Scheduler must not read response body"); },
      text() { assert.fail("Scheduler must not read response text"); },
      json() { assert.fail("Scheduler must not read response JSON"); },
    };
  });
  const info = t.mock.method(console, "info", () => {});
  const error = t.mock.method(console, "error", () => {});
  await worker.scheduled({}, scheduledEnvironment());
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(timeout.mock.callCount(), 1);
  assert.deepEqual(info.mock.calls.map(call => call.arguments), [["CAD_SCHEDULED_POLL", { status: 200 }]]);
  assert.equal(error.mock.callCount(), 0);
});

test("scheduler records only status for HTTP failures without reading private error bodies", async t => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false, status: 503,
    text() { assert.fail("No error response body should be read"); },
    json() { assert.fail("No error response JSON should be read"); },
  }));
  const info = t.mock.method(console, "info", () => {});
  const error = t.mock.method(console, "error", () => {});
  await worker.scheduled({}, scheduledEnvironment());
  assert.equal(info.mock.callCount(), 0);
  assert.deepEqual(error.mock.calls.map(call => call.arguments), [["CAD_SCHEDULED_POLL_FAILED", { status: 503 }]]);
});

test("scheduler sanitizes network exceptions and never logs headers or credentials", async t => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(`private upstream content and credential ${TOKEN}`);
  });
  const info = t.mock.method(console, "info", () => {});
  const error = t.mock.method(console, "error", () => {});
  await worker.scheduled({}, scheduledEnvironment());
  assert.equal(info.mock.callCount(), 0);
  assert.deepEqual(error.mock.calls.map(call => call.arguments), [["CAD_SCHEDULED_POLL_FAILED", { code: "REQUEST_FAILED" }]]);
});

test("scheduler rejects missing and invalid secrets without network or database requests", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => assert.fail("Invalid configuration must not fetch"));
  const info = t.mock.method(console, "info", () => {});
  const error = t.mock.method(console, "error", () => {});
  const invalidTokens = [undefined, null, "", "x".repeat(31), "x".repeat(257), 123];
  for (const token of invalidTokens) await worker.scheduled({}, scheduledEnvironment({ CAD_API_TOKEN: token }));
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(info.mock.callCount(), 0);
  assert.deepEqual(error.mock.calls.map(call => call.arguments), invalidTokens.map(() => [
    "CAD_SCHEDULED_POLL_FAILED", { code: "CONFIGURATION_ERROR" },
  ]));
});


test("scheduler treats redirects as failures and never forwards the bearer token", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://www.villahillsfd.org/api/cad-poll");
    assert.equal(options.redirect, "manual");
    return {
      ok: false, status: 302,
      headers: new Headers({ Location: "https://untrusted.example.test/redirect" }),
      text() { assert.fail("Redirect response body must not be read"); },
      json() { assert.fail("Redirect response JSON must not be read"); },
    };
  });
  const info = t.mock.method(console, "info", () => {});
  const error = t.mock.method(console, "error", () => {});
  await worker.scheduled({}, scheduledEnvironment());
  assert.equal(fetchMock.mock.callCount(), 1, "No request may be made to the redirect destination");
  assert.equal(info.mock.callCount(), 0);
  assert.deepEqual(error.mock.calls.map(call => call.arguments), [["CAD_SCHEDULED_POLL_FAILED", { status: 302 }]]);
});
