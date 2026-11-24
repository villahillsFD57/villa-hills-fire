/** Bounded, read-only Gmail retrieval for recovering dispatches missed by the old unread-only poller. */
import { getGmailClient, extractPlainText, requestErrorCode, type RawEmail } from "./gmail";

const PAGE_SIZE = 20;
const FETCH_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export interface RecoveryWindow {
  start: string;
  end: string;
  pageToken?: string;
}

export interface RecoveryPage {
  emails: RawEmail[];
  rejected: number;
  failures: string[];
  nextPageToken: string | null;
  examined: number;
}

/** Validate a fixed, explicit window; never silently broaden a recovery request. */
export function validateRecoveryWindow(value: unknown, now = Date.now()): RecoveryWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.start !== "string" || typeof input.end !== "string") return null;
  // Require explicit timezone information to avoid browser/server timezone drift.
  const timestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  if (!timestamp.test(input.start) || !timestamp.test(input.end)) return null;
  for (const value of [input.start, input.end]) {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1
      || calendarDate.getUTCDate() !== day) return null;
  }
  const start = Date.parse(input.start);
  const end = Date.parse(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end
    || end - start > MAX_WINDOW_MS || end > now + 60_000) return null;
  if (input.pageToken !== undefined && (typeof input.pageToken !== "string"
    || input.pageToken.length === 0 || input.pageToken.length > 4096
    || /[\u0000-\u0020\u007f]/.test(input.pageToken))) return null;
  return {
    start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    ...(input.pageToken ? { pageToken: input.pageToken as string } : {}),
  };
}

export async function fetchRecoveryPage(window: RecoveryWindow, signal?: AbortSignal): Promise<RecoveryPage> {
  const gmail = getGmailClient();
  const userId = process.env.GMAIL_USER ?? "villahillscad@gmail.com";
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  // Deliberately no is:unread: the old failure handler marked missed calls read.
  // Ignore custom poll queries so recovery cannot broaden its sender boundary.
  const query = `(from:alert@cfmsg.co OR from:${userId}) subject:"Chief Alert" after:${Math.floor(start / 1000) - 1} before:${Math.ceil(end / 1000)}`;
  const options = { timeout: REQUEST_TIMEOUT_MS, retry: false, signal } as const;
  let list;
  try {
    list = await gmail.users.messages.list({
      userId, q: query, maxResults: PAGE_SIZE,
      ...(window.pageToken ? { pageToken: window.pageToken } : {}),
    }, options);
  } catch (error) {
    throw new Error(requestErrorCode(error));
  }

  const messages = (list.data.messages ?? []).slice(0, PAGE_SIZE);
  const page: RecoveryPage = {
    emails: [], rejected: 0, failures: [],
    nextPageToken: list.data.nextPageToken ?? null,
    examined: messages.length,
  };
  let index = 0;
  async function worker() {
    while (index < messages.length) {
      const message = messages[index++];
      if (!message.id) { page.failures.push("GMAIL_MESSAGE_ID_MISSING"); continue; }
      if (signal?.aborted) { page.failures.push("GMAIL_BATCH_DEFERRED"); continue; }
      try {
        const result = await gmail.users.messages.get({ userId, id: message.id, format: "full" }, options);
        const payload = result.data.payload;
        const header = (name: string) => payload?.headers?.find(h => h.name?.toLowerCase() === name)?.value ?? "";
        const fromHeader = header("from");
        const from = (fromHeader.match(/<([^<>]+)>/)?.[1] ?? fromHeader).toLowerCase().trim();
        if (from !== "alert@cfmsg.co" && from !== userId.toLowerCase().trim()) {
          page.rejected++; continue;
        }
        const internalDate = Number(result.data.internalDate);
        const received = Number.isFinite(internalDate) && internalDate > 0
          ? new Date(internalDate) : new Date(header("date"));
        if (!Number.isFinite(received.getTime())) {
          page.failures.push("GMAIL_TIMESTAMP_INVALID"); continue;
        }
        // Gmail's date query has second granularity; enforce exact [start, end).
        if (received.getTime() < start || received.getTime() >= end) { page.rejected++; continue; }
        page.emails.push({
          id: message.id, from, subject: header("subject"),
          body: extractPlainText(payload), received,
        });
      } catch (error) {
        page.failures.push(requestErrorCode(error));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, messages.length) }, worker));
  page.emails.sort((a, b) => a.received.getTime() - b.received.getTime() || a.id.localeCompare(b.id));
  return page;
}
