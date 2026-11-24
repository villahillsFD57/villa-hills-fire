import assert from "node:assert/strict";
import { mock, test } from "node:test";

process.env.GMAIL_CLIENT_ID = "offline-test-client";
process.env.GMAIL_CLIENT_SECRET = "offline-test-secret";
process.env.GMAIL_REFRESH_TOKEN = "offline-test-refresh";
process.env.GMAIL_USER = "cad-inbox@example.test";
delete process.env.GMAIL_SEARCH_QUERY;

let listHandler;
let getHandler;
let modifyHandler;
let labels = [];
let authOptions;
const requestOptions = [];
const modifications = [];
const labelCreations = [];

mock.module("googleapis", {
  namedExports: {
    google: {
      auth: { OAuth2: class {
        constructor(options) { authOptions = options; }
        setCredentials() {}
      } },
      gmail: () => ({ users: { labels: {
        list: async (args, options) => { requestOptions.push(options); return { data: { labels } }; },
        create: async (args, options) => {
          requestOptions.push(options);
          labelCreations.push(args);
          const created = { id: `Label_${labelCreations.length}`, name: args.requestBody.name };
          labels.push(created);
          return { data: created };
        },
      }, messages: {
        list: (args, options) => { requestOptions.push(options); return listHandler(args); },
        get: (args, options) => { requestOptions.push(options); return getHandler(args); },
        modify: (args, options) => {
          requestOptions.push(options); modifications.push(args); return modifyHandler(args);
        },
      } } }),
    },
  },
});

const { fetchDispatchBatch, markAsRead } = await import("../lib/cad/gmail.ts");
const delivered = Date.parse("2026-11-24T02:30:00Z");
const message = (from = "Chief Dispatch <alert@cfmsg.co>") => ({ data: {
  internalDate: String(delivered),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "from", value: from },
      { name: "sUbJeCt", value: "Chief Alert" },
      { name: "date", value: "invalid header date" },
    ],
    body: { data: Buffer.from("synthetic dispatch fixture").toString("base64url") },
  },
} });

test("one message fetch failure does not block good messages or acknowledge anything", async () => {
  listHandler = async () => ({ data: { messages: [{ id: "good-1" }, { id: "failed" }, { id: "good-2" }] } });
  getHandler = async ({ id }) => {
    if (id === "failed") throw { response: { status: 503, data: "private response" } };
    return message();
  };
  const result = await fetchDispatchBatch();
  assert.deepEqual(result.emails.map(e => e.id).sort(), ["good-1", "good-2"]);
  assert.deepEqual(result.failures, [{ id: "failed", code: "GMAIL_HTTP_503" }]);
  assert.equal(modifications.length, 0);
  assert.equal(result.emails[0].received.getTime(), delivered);
  assert.equal(result.emails[0].subject, "Chief Alert");
  assert.deepEqual(authOptions.transporterOptions, { timeout: 5000, retry: false });
  assert.ok(requestOptions.every(o => o.timeout === 5000 && o.retry === false));
});

test("read alerts remain eligible and old search overrides cannot reintroduce unread dependence", async () => {
  process.env.GMAIL_SEARCH_QUERY = "is:unread";
  listHandler = async args => {
    assert.doesNotMatch(args.q, /is:unread|is:read/);
    assert.match(args.q, /-label:"VHFD-Website-Processed"/);
    assert.match(args.q, /from:alert@cfmsg\.co/);
    return { data: { messages: [{ id: "untrusted" }, { id: "forwarded" }] } };
  };
  getHandler = async ({ id }) => message(id === "untrusted" ? "attacker@example.test" : "cad-inbox@example.test");
  const result = await fetchDispatchBatch();
  assert.deepEqual(result.emails.map(e => e.id), ["forwarded"]);
  assert.deepEqual(result.failures, [{ id: "untrusted", code: "UNTRUSTED_SENDER" }]);
  assert.equal(modifications.length, 0);
  assert.equal(labelCreations.length, 0, "Fetching must remain read-only");
  delete process.env.GMAIL_SEARCH_QUERY;
});

test("backlog retrieval is limited to 10 and at most 4 simultaneous requests", async () => {
  let active = 0;
  let peak = 0;
  let requested = 0;
  listHandler = async (args) => {
    assert.equal(args.maxResults, 10);
    assert.doesNotMatch(args.q, /is:unread/);
    return { data: { messages: Array.from({ length: 30 }, (_, i) => ({ id: `item-${i}` })) } };
  };
  getHandler = async () => {
    requested++;
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return message();
  };
  const result = await fetchDispatchBatch();
  assert.equal(result.emails.length, 10);
  assert.equal(requested, 10);
  assert.equal(peak, 4);
});

test("expired fetch budget defers messages without fetching or marking read", async () => {
  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    listHandler = async () => {
      clock = 20000;
      return { data: { messages: [{ id: "later" }] } };
    };
    getHandler = async () => assert.fail("No fetch is allowed after the batch budget");
    const result = await fetchDispatchBatch();
    assert.deepEqual(result, { emails: [], failures: [{ id: "later", code: "GMAIL_BATCH_DEFERRED" }] });
    assert.equal(modifications.length, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("OAuth errors are sanitized instead of returning request/credential details", async () => {
  listHandler = async () => { throw {
    response: { status: 400, data: { error: "invalid_grant", private: "must not appear" } },
    message: "must not appear",
  }; };
  await assert.rejects(fetchDispatchBatch(), { message: "GMAIL_AUTH_REVOKED" });
});

test("acknowledgment creates/reuses a processed label and preserves read state", async () => {
  modifyHandler = async () => ({ data: {} });
  await markAsRead("stored-first");
  await markAsRead("confirmed-duplicate");
  assert.equal(labelCreations.length, 1);
  assert.equal(labelCreations[0].requestBody.name, "VHFD-Website-Processed");
  for (const modification of modifications) {
    assert.deepEqual(modification.requestBody, { addLabelIds: ["Label_1"] });
    assert.equal(modification.requestBody.removeLabelIds, undefined);
  }
});

test("failed acknowledgment reports timeout so the caller can retry without losing the call", async () => {
  modifyHandler = async () => { throw { code: "ETIMEDOUT", message: "private details" }; };
  await assert.rejects(markAsRead("saved-message"), { message: "GMAIL_TIMEOUT" });
  assert.deepEqual(modifications.at(-1), {
    userId: "cad-inbox@example.test", id: "saved-message", requestBody: { addLabelIds: ["Label_1"] },
  });
});

test("deleted checkpoint label is recreated on retry without changing message read state", async () => {
  labels = [];
  modifyHandler = async () => { throw { response: { status: 404 } }; };
  await assert.rejects(markAsRead("retryable-message"), { message: "GMAIL_HTTP_404" });
  modifyHandler = async () => ({ data: {} });
  await markAsRead("retryable-message");
  assert.equal(labelCreations.length, 2);
  assert.deepEqual(modifications.at(-1).requestBody, { addLabelIds: ["Label_2"] });
});
