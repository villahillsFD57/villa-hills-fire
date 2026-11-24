/**
 * Chief 360 Fire CAD email parser.
 *
 * Tuned for the actual email format Villa Hills receives:
 *
 *   Subject: Chief Alert
 *   Body:    [NN Fire CAD] CALL TYPE -- ADDRESS CITY, ST ZIP -- Box: ... -- Units: ...
 *
 * Strict by design — we only ingest emails that match this exact body
 * pattern AND list a Villa Hills unit (VLHL) in the units list.
 */

const CAD_BODY_RE =
  /\[\d+\s+Fire\s+CAD\]\s+(.+?)\s+--\s+(.+?)\s+--\s+Box:\s+.+?\s+--\s+Units:\s+(.+)/i;

export interface ParsedCall {
  status: "ok";
  dispatchDate: string;     // "MM/DD/YYYY" Chicago-local
  dispatchTime: string;     // "HH:MM" Chicago-local 24h
  dispatchNature: string;   // e.g. "WIRES DOWN"
  dispatchDatetime: string; // ISO-8601 UTC
  sourceYear: number;       // Chicago calendar year
}

export interface ParseFailure {
  status: "failed";
  reason: string;
}

export type ParseResult = ParsedCall | ParseFailure;

function stripSubjectPrefixes(s: string): string {
  return s.trim().replace(/^(?:(?:fwd?|re|fw):\s*)+/i, "").trim().replace(/\s+/g, " ");
}

/**
 * Parse a Chief 360 Fire CAD dispatch email.
 *
 * Returns a ParsedCall on success, or ParseFailure with a reason if the
 * email doesn't look like a real Villa Hills dispatch (subject wrong,
 * body doesn't match the [NN Fire CAD] pattern, or no VLHL unit listed).
 */
export function parseDispatchEmail(
  subject: string,
  body: string,
  received: Date,
): ParseResult {
  const cleanSubject = stripSubjectPrefixes(subject);
  if (cleanSubject.toLowerCase() !== "chief alert") {
    return { status: "failed", reason: "Wrong subject" };
  }

  // Plain-text email can be folded across lines; retain the strict CAD fields.
  const m = body.replace(/\s+/g, " ").trim().match(CAD_BODY_RE);
  if (!m) {
    return { status: "failed", reason: "Body does not match [NN Fire CAD] pattern" };
  }

  const [, callType, , units] = m;
  if (!/\bVLHL\b/i.test(units)) {
    return { status: "failed", reason: "No VLHL unit in dispatch" };
  }
  const dispatchNature = callType.trim();
  if (!dispatchNature || dispatchNature.length > 160 || /[<>@\u0000-\u001f\u007f]/.test(dispatchNature)) {
    return { status: "failed", reason: "Invalid dispatch nature" };
  }

  if (!Number.isFinite(received.getTime())) {
    return { status: "failed", reason: "Invalid received timestamp" };
  }

  // formatToParts avoids locale punctuation assumptions and hour 24 at midnight.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(received);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  const dispatchDate = `${part("month")}/${part("day")}/${part("year")}`;
  const dispatchTime = `${part("hour")}:${part("minute")}`;
  const sourceYear = Number(part("year"));
  if (sourceYear < 1900 || sourceYear > 2200) {
    return { status: "failed", reason: "Invalid received timestamp" };
  }

  return {
    status: "ok",
    dispatchDate,
    dispatchTime,
    dispatchNature,
    dispatchDatetime: received.toISOString(),
    sourceYear,
  };
}
