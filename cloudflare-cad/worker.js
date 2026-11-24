// Private CAD storage service. Bind a D1 database as DB and set CAD_API_TOKEN
// as a Worker secret. Apply schema.sql before deploying this file.
const MAX_BODY_BYTES = 16_384;
const CALL_COLUMNS = "id, dispatch_datetime, dispatch_date, dispatch_time, dispatch_nature, source_year, created_at";
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

class InputError extends Error {
  constructor(code = "INVALID_REQUEST", status = 400) {
    super(code);
    this.status = status;
  }
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status, headers: { ...JSON_HEADERS, ...headers },
  });
}

async function authorized(request, secret) {
  const provided = request.headers.get("authorization") ?? "";
  if (provided.length > 512) return false;
  // Hash to equal lengths, then compare every byte without early return.
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${secret}`)),
  ]);
  const a = new Uint8Array(actual);
  const b = new Uint8Array(expected);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function readJson(request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new InputError("JSON_REQUIRED", 415);
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (declaredLength > MAX_BODY_BYTES) throw new InputError("REQUEST_TOO_LARGE", 413);
  if (!request.body) throw new InputError();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new InputError("REQUEST_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new InputError("INVALID_JSON");
  }
}

function object(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError();
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) throw new InputError();
  if (requiredKeys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new InputError();
  return value;
}

function text(value, maximum, pattern) {
  if (typeof value !== "string" || !value.length || value.length > maximum || value !== value.trim()
      || /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))) {
    throw new InputError();
  }
  return value;
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new InputError();
  return value;
}

function optionalInteger(value, maximum) {
  return value === undefined || value === null ? null : integer(value, 0, maximum);
}

function identifier(value) { return text(value, 160, /^[A-Za-z0-9_-]+$/); }
function year(value) { return integer(value, 1900, 2200); }

function nature(value) {
  // Store only the dispatch category. No raw email body, address or extra fields.
  return text(value, 160, /^[^<>@\r\n]+$/);
}

function callInput(value) {
  const data = object(value, [
    "gmailMessageId", "dispatchDatetime", "dispatchDate", "dispatchTime", "dispatchNature", "sourceYear",
  ]);
  const gmailMessageId = identifier(data.gmailMessageId);
  const datetime = text(data.dispatchDatetime, 40, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  const instant = new Date(datetime);
  if (!Number.isFinite(instant.getTime())) throw new InputError();
  const [stampYear, stampMonth, stampDay] = datetime.slice(0, 10).split("-").map(Number);
  const stampCheck = new Date(Date.UTC(stampYear, stampMonth - 1, stampDay));
  if (stampCheck.getUTCFullYear() !== stampYear || stampCheck.getUTCMonth() !== stampMonth - 1
      || stampCheck.getUTCDate() !== stampDay) throw new InputError();
  const date = text(data.dispatchDate, 10, /^\d{2}\/\d{2}\/\d{4}$/);
  const [month, day, localYear] = date.split("/").map(Number);
  const check = new Date(Date.UTC(localYear, month - 1, day));
  if (check.getUTCFullYear() !== localYear || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new InputError();
  }
  const sourceYear = year(data.sourceYear);
  if (sourceYear !== localYear) throw new InputError();
  const time = text(data.dispatchTime, 5, /^(?:[01]\d|2[0-3]):[0-5]\d$/);
  return {
    gmailMessageId, dispatchDatetime: instant.toISOString(), dispatchDate: date,
    dispatchTime: time, dispatchNature: nature(data.dispatchNature), sourceYear,
  };
}

function rowToCall(row) {
  if (!row) throw new Error("CAD_ROW_MISSING");
  return {
    id: row.id, dispatchDatetime: row.dispatch_datetime,
    dispatchDate: row.dispatch_date, dispatchTime: row.dispatch_time,
    dispatchNature: row.dispatch_nature, sourceYear: Number(row.source_year),
    createdAt: row.created_at,
  };
}

function pollInput(value) {
  const data = object(value, ["checked", "stored", "inboxTotal", "durationMs", "error"], []);
  let error = null;
  if (data.error !== undefined && data.error !== null) {
    // Diagnostics are codes only; never persist email content or OAuth responses.
    error = text(data.error, 500, /^[A-Z0-9_ :,;.-]+$/);
  }
  return {
    checked: optionalInteger(data.checked, 1_000_000),
    stored: optionalInteger(data.stored, 1_000_000),
    inboxTotal: optionalInteger(data.inboxTotal, 100_000_000),
    durationMs: optionalInteger(data.durationMs, 3_600_000), error,
  };
}

async function query(db, input) {
  object(input, ["operation", "gmailMessageId", "data", "year", "limit", "callId", "newNature"], ["operation"]);
  switch (input.operation) {
    case "duplicate": {
      object(input, ["operation", "gmailMessageId"]);
      const id = identifier(input.gmailMessageId);
      const row = await db.prepare("SELECT 1 AS found FROM cad_calls WHERE gmail_message_id = ? LIMIT 1").bind(id).first();
      return Boolean(row);
    }
    case "saveCall": {
      object(input, ["operation", "data"]);
      const data = callInput(input.data);
      const results = await db.batch([
        db.prepare(`INSERT INTO cad_calls
          (id, gmail_message_id, dispatch_datetime, dispatch_date, dispatch_time, dispatch_nature, source_year)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(gmail_message_id) DO NOTHING`).bind(
            crypto.randomUUID(), data.gmailMessageId, data.dispatchDatetime,
            data.dispatchDate, data.dispatchTime, data.dispatchNature, data.sourceYear,
          ),
        db.prepare(`SELECT ${CALL_COLUMNS} FROM cad_calls WHERE gmail_message_id = ?`).bind(data.gmailMessageId),
      ]);
      return rowToCall(results[1].results[0]);
    }
    case "snapshot": {
      object(input, ["operation", "year"]);
      const sourceYear = year(input.year);
      const results = await db.batch([
        db.prepare(`SELECT ${CALL_COLUMNS} FROM cad_calls ORDER BY dispatch_datetime DESC, id DESC LIMIT 10`),
        db.prepare("SELECT COUNT(*) AS total FROM cad_calls WHERE source_year = ?").bind(sourceYear),
        db.prepare("SELECT value FROM cad_metadata WHERE key = ? LIMIT 1").bind(`count_complete:${sourceYear}`),
      ]);
      return {
        latest: results[0].results.map(rowToCall),
        count: Number(results[1].results[0].total), year: sourceYear,
        updatedAt: new Date().toISOString(),
        countComplete: results[2].results[0]?.value === "true",
      };
    }
    case "log": {
      object(input, ["operation", "year"]);
      const sourceYear = year(input.year);
      const rows = await db.prepare(`SELECT ${CALL_COLUMNS} FROM cad_calls
        WHERE source_year = ? ORDER BY dispatch_datetime DESC, id DESC`).bind(sourceYear).all();
      return rows.results.map(rowToCall);
    }
    case "pollHistory": {
      object(input, ["operation", "limit"], ["operation"]);
      const limit = input.limit === undefined ? 50 : integer(input.limit, 1, 100);
      const rows = await db.prepare(`SELECT ran_at, checked, stored, inbox_total, duration_ms, error
        FROM cad_poll_log ORDER BY ran_at DESC, id DESC LIMIT ?`).bind(limit).all();
      return rows.results.map(row => ({
        ranAt: row.ran_at, checked: row.checked, stored: row.stored,
        inboxTotal: row.inbox_total, durationMs: row.duration_ms, error: row.error,
      }));
    }
    case "logPollRun": {
      object(input, ["operation", "data"]);
      const data = pollInput(input.data);
      await db.prepare(`INSERT INTO cad_poll_log (checked, stored, inbox_total, duration_ms, error)
        VALUES (?, ?, ?, ?, ?)`).bind(data.checked, data.stored, data.inboxTotal, data.durationMs, data.error).run();
      return null;
    }
    case "updateCallNature": {
      object(input, ["operation", "callId", "newNature"]);
      await db.prepare("UPDATE cad_calls SET dispatch_nature = ? WHERE id = ?")
        .bind(nature(input.newNature), identifier(input.callId)).run();
      return null;
    }
    case "deleteCall": {
      object(input, ["operation", "callId"]);
      await db.prepare("DELETE FROM cad_calls WHERE id = ?").bind(identifier(input.callId)).run();
      return null;
    }
    default:
      throw new InputError("UNKNOWN_OPERATION");
  }
}

export default {
  async scheduled(_event, env) {
    if (env.CAD_POLL_ENABLED !== "true") return;
    const secret = env.CAD_API_TOKEN;
    if (typeof secret !== "string" || secret.length < 32 || secret.length > 256) {
      console.error("CAD_SCHEDULED_POLL_FAILED", { code: "CONFIGURATION_ERROR" });
      return;
    }
    try {
      const response = await fetch("https://www.villahillsfd.org/api/cad-poll", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        redirect: "manual",
        signal: AbortSignal.timeout(55_000),
      });
      if (response.ok) console.info("CAD_SCHEDULED_POLL", { status: response.status });
      else console.error("CAD_SCHEDULED_POLL_FAILED", { status: response.status });
    } catch (error) {
      console.error("CAD_SCHEDULED_POLL_FAILED", {
        code: "REQUEST_FAILED",
        detail: String(error).replaceAll(secret, "[redacted]").slice(0, 300),
      });
    }
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/v1/query") return json({ error: "NOT_FOUND" }, 404);
    if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
    const secret = env.CAD_API_TOKEN;
    if (typeof secret !== "string" || secret.length < 32 || secret.length > 256 || !env.DB) {
      return json({ error: "SERVICE_UNAVAILABLE" }, 503);
    }
    if (!(await authorized(request, secret))) return json({ error: "UNAUTHORIZED" }, 401);
    try {
      return json(await query(env.DB, await readJson(request)));
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status);
      console.error("CAD_DATABASE_OPERATION_FAILED");
      return json({ error: "SERVICE_UNAVAILABLE" }, 503);
    }
  },
};
