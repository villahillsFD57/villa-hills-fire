/**
 * Gmail API client for reading Chief 360 dispatch emails.
 * Cloned from millstadt-ems with the search query changed for Villa Hills FD.
 *
 * Auth: OAuth2 with a stored refresh token for villahillscad@gmail.com.
 * The refresh token is obtained once (see setup instructions in .env.example)
 * and stored as an environment variable. The client auto-refreshes the access
 * token on every poll so no manual intervention is needed.
 *
 * Required env vars:
 *   GMAIL_CLIENT_ID
 *   GMAIL_CLIENT_SECRET
 *   GMAIL_REFRESH_TOKEN
 *   GMAIL_USER          (villahillscad@gmail.com)
 */

import { google, type gmail_v1 } from "googleapis";

const REQUEST_TIMEOUT_MS = 5_000;
const BATCH_BUDGET_MS = 20_000;
const BATCH_SIZE = 10;
const FETCH_CONCURRENCY = 4;
const PROCESSED_LABEL = "VHFD-Website-Processed";
const REQUEST_OPTIONS = { timeout: REQUEST_TIMEOUT_MS, retry: false } as const;
let gmailClient: gmail_v1.Gmail | undefined;
let processedLabelPromise: Promise<string> | undefined;

// ── OAuth2 client ──────────────────────────────────────────────────────────

export function getGmailClient(): gmail_v1.Gmail {
  if (gmailClient) return gmailClient;
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;

  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error(
      "GMAIL_CREDENTIALS_MISSING"
    );
  }

  const auth = new google.auth.OAuth2({
    clientId: GMAIL_CLIENT_ID,
    clientSecret: GMAIL_CLIENT_SECRET,
    transporterOptions: REQUEST_OPTIONS,
  });
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  gmailClient = google.gmail({ version: "v1", auth });
  return gmailClient;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface RawEmail {
  id: string;        // Gmail message ID (deduplication key)
  from: string;      // Sender email address (lowercase)
  subject: string;
  body: string;      // Plain text (HTML stripped)
  received: Date;    // Date the email was delivered
}

export interface DispatchBatch {
  emails: RawEmail[];
  failures: Array<{ id: string; code: string }>;
}

// Do not expose OAuth response bodies, request headers, or message content in logs.
export function requestErrorCode(error: unknown): string {
  const e = error as {
    code?: string; name?: string;
    response?: { status?: number; data?: { error?: string } };
  } | null;
  if (e?.response?.data?.error === "invalid_grant") return "GMAIL_AUTH_REVOKED";
  if (e?.code === "ETIMEDOUT" || e?.code === "ECONNABORTED" || e?.name === "AbortError") {
    return "GMAIL_TIMEOUT";
  }
  const status = e?.response?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
    return `GMAIL_HTTP_${status}`;
  }
  return "GMAIL_REQUEST_FAILED";
}

// ── Fetch unprocessed dispatch emails ───────────────────────────────────────

/**
 * Search all retained Chief 360 fire dispatch emails not yet acknowledged.
 * Returns raw email data — parsing happens separately in parser.ts.
 *
 * Gmail's read/unread state belongs to the mailbox user. A dedicated processed
 * label is our durable checkpoint, so reading an alert cannot make us miss it.
 * Each successful batch advances through retained history, newest first.
 * This function is read-only; a label is created lazily on acknowledgment.
 */
export async function fetchDispatchBatch(): Promise<DispatchBatch> {
  const startedAt = Date.now();
  const gmail = getGmailClient();
  const userId = process.env.GMAIL_USER ?? "villahillscad@gmail.com";

  // Deliberately replace the old configurable unread search: no override can
  // silently restore the read-state dependency or remove our checkpoint filter.
  const searchQuery = `(from:alert@cfmsg.co OR from:${userId}) subject:"Chief Alert" -label:"${PROCESSED_LABEL}"`;

  let listRes;
  try {
    listRes = await gmail.users.messages.list({
      userId, q: searchQuery, maxResults: BATCH_SIZE,
    }, REQUEST_OPTIONS);
  } catch (error) {
    throw new Error(requestErrorCode(error));
  }

  const messages = (listRes.data.messages ?? []).slice(0, BATCH_SIZE);
  const batch: DispatchBatch = { emails: [], failures: [] };
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < messages.length) {
      const msg = messages[nextIndex++];
      if (!msg.id) continue;
      if (Date.now() - startedAt >= BATCH_BUDGET_MS) {
        batch.failures.push({ id: msg.id, code: "GMAIL_BATCH_DEFERRED" });
        continue;
      }
      try {
        const full = await gmail.users.messages.get({
          userId, id: msg.id, format: "full",
        }, REQUEST_OPTIONS);
        const payload = full.data.payload;
        const headers = payload?.headers ?? [];
        const header = (name: string) => headers.find(h => h.name?.toLowerCase() === name)?.value ?? "";
        const fromHdr = header("from");
        const from = (fromHdr.match(/<([^<>]+)>/)?.[1] ?? fromHdr).toLowerCase().trim();

        // Verify the actual From header as well as the Gmail search result.
        if (from !== "alert@cfmsg.co" && from !== userId.toLowerCase().trim()) {
          batch.failures.push({ id: msg.id, code: "UNTRUSTED_SENDER" });
          continue;
        }

        const internalDate = Number(full.data.internalDate);
        const received = Number.isFinite(internalDate) && internalDate > 0
          ? new Date(internalDate)
          : new Date(header("date"));
        batch.emails.push({
          id: msg.id, from, subject: header("subject"),
          body: extractPlainText(payload), received,
        });
      } catch (error) {
        // A single unavailable message must not block the rest of the batch.
        batch.failures.push({ id: msg.id, code: requestErrorCode(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, messages.length) }, worker));
  return batch;
}

/** Legacy name, now read-state-independent; this remains a read-only fetch. */
export async function fetchUnreadDispatchEmails(): Promise<RawEmail[]> {
  return (await fetchDispatchBatch()).emails;
}

function getProcessedLabelId(gmail: gmail_v1.Gmail, userId: string): Promise<string> {
  if (!processedLabelPromise) {
    processedLabelPromise = (async () => {
      async function findExisting() {
        const response = await gmail.users.labels.list({ userId }, REQUEST_OPTIONS);
        return response.data.labels?.find(label =>
          label.name?.toLowerCase() === PROCESSED_LABEL.toLowerCase()
        )?.id;
      }
      const existing = await findExisting();
      if (existing) return existing;
      try {
        const created = await gmail.users.labels.create({
          userId,
          requestBody: {
            name: PROCESSED_LABEL,
            labelListVisibility: "labelHide",
            messageListVisibility: "hide",
          },
        }, REQUEST_OPTIONS);
        if (!created.data.id) throw new Error("GMAIL_LABEL_UNAVAILABLE");
        return created.data.id;
      } catch (error) {
        // Concurrent cold instances may both attempt the same label creation.
        if (requestErrorCode(error) === "GMAIL_HTTP_409") {
          const existingAfterRace = await findExisting();
          if (existingAfterRace) return existingAfterRace;
        }
        throw error;
      }
    })().catch(error => {
      processedLabelPromise = undefined;
      throw error;
    });
  }
  return processedLabelPromise;
}

/**
 * Legacy export name: acknowledge processing with a dedicated label.
 * Called only after a durable save, confirmed duplicate, or intentional rejection.
 * Never change read/unread state. A transient failure leaves the message without
 * the processed label, so the next poll retries it even if someone has read it.
 */
export async function markAsRead(messageId: string): Promise<void> {
  const gmail = getGmailClient();
  const userId = process.env.GMAIL_USER ?? "villahillscad@gmail.com";

  try {
    const labelId = await getProcessedLabelId(gmail, userId);
    await gmail.users.messages.modify({
      userId,
      id: messageId,
      requestBody: { addLabelIds: [labelId] },
    }, REQUEST_OPTIONS);
  } catch (error) {
    // If the dedicated label was removed, rediscover/recreate it on the next try.
    if (requestErrorCode(error) === "GMAIL_HTTP_404") processedLabelPromise = undefined;
    throw new Error(requestErrorCode(error));
  }
}

// ── Body extraction helpers ────────────────────────────────────────────────

export function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64(payload.body.data);
  }

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(decodeBase64(payload.body.data));
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return stripHtml(decodeBase64(part.body.data));
      }
      if (part.mimeType?.startsWith("multipart/")) {
        const nested = extractPlainText(part);
        if (nested) return nested;
      }
    }
  }

  return "";
}

function decodeBase64(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}
