/**
 * Gmail dispatch poll. Empty runs never query storage. Messages receive a
 * processing label only after durable storage or an intentional rejection.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchDispatchBatch, markAsRead } from "@/lib/cad/gmail";
import { parseDispatchEmail } from "@/lib/cad/parser";
import { isDuplicate, saveCall, logPollRun } from "@/lib/cad/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) { return handlePoll(req); }
export async function POST(req: NextRequest) { return handlePoll(req); }

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET ?? process.env.CAD_STORE_TOKEN;
  // D1's private token authenticates the managed Cloudflare scheduler. Keep
  // legacy compatibility only before either server-side secret is configured.
  if (!secret) return true;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  const supplied = req.nextUrl.searchParams.get("token")
    ?? req.nextUrl.searchParams.get("secret");
  // Vercel Cron uses Authorization: Bearer CRON_SECRET. An arbitrary
  // x-vercel-cron-signature header is not proof of authentication.
  return supplied === secret;
}

async function handlePoll(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const deadline = startedAt + 45_000;
  const databaseDeadline = AbortSignal.timeout(45_000);
  const results = {
    processed: 0, duplicates: 0, skipped: 0, failed: 0, deferred: 0,
    errors: [] as string[],
  };
  let examined = 0;

  async function acknowledge(id: string) {
    try {
      await markAsRead(id);
    } catch {
      // Stored dispatches remain safe: the unique Gmail ID deduplicates a retry.
      results.failed++;
      results.errors.push("GMAIL_ACKNOWLEDGEMENT_FAILED");
    }
  }

  try {
    const batch = await fetchDispatchBatch();
    examined = batch.emails.length + batch.failures.length;
    for (const failure of batch.failures) {
      if (failure.code === "UNTRUSTED_SENDER") {
        if (Date.now() >= deadline) {
          results.deferred++;
          continue;
        }
        results.skipped++;
        // A verified search false-positive is intentionally rejected. Advance
        // the processing checkpoint so it cannot permanently fill every batch.
        await acknowledge(failure.id);
      } else {
        results.failed++;
        results.errors.push(failure.code);
      }
    }

    for (let index = 0; index < batch.emails.length; index++) {
      if (Date.now() >= deadline) {
        results.deferred += batch.emails.length - index;
        break; // Leave messages unacknowledged for the next scheduled run.
      }
      const email = batch.emails[index];
      const parsed = parseDispatchEmail(email.subject, email.body, email.received);
      if (parsed.status === "failed") {
        results.skipped++;
        await acknowledge(email.id);
        continue; // Rejected mail never wakes the database.
      }

      try {
        if (await isDuplicate(email.id, databaseDeadline)) {
          results.duplicates++;
          await acknowledge(email.id);
          continue;
        }
        await saveCall({
          gmailMessageId: email.id,
          dispatchDatetime: parsed.dispatchDatetime,
          dispatchDate: parsed.dispatchDate,
          dispatchTime: parsed.dispatchTime,
          dispatchNature: parsed.dispatchNature,
          sourceYear: parsed.sourceYear,
        }, databaseDeadline);
        results.processed++;
        await acknowledge(email.id);
      } catch {
        results.failed++;
        results.errors.push("CAD_DATABASE_WRITE_FAILED");
        // A quota pause or transient DB failure affects every remaining item.
        // Stop hammering it; do not acknowledge any of those messages.
        results.deferred += batch.emails.length - index - 1;
        break;
      }
    }

    // Record successful ingestion events only, never empty polling heartbeats.
    // Empty successes and failures use hosting logs, never a DB health probe.
    if (results.processed > 0 && results.failed === 0 && Date.now() < deadline) {
      await logPollRun({
        checked: examined, stored: results.processed,
        durationMs: Date.now() - startedAt,
      });
    }

    const ok = results.failed === 0 && results.deferred === 0;
    const report = { ok, ...results, examined, durationMs: Date.now() - startedAt };
    if (ok) console.info("CAD_POLL", report);
    else console.error("CAD_POLL_INCOMPLETE", report);
    return NextResponse.json(report, {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store", ...(ok ? {} : { "Retry-After": "60" }) },
    });
  } catch (error) {
    // Keep credentials, message bodies and database URLs out of logs/responses.
    const message = error && typeof error === "object" && "message" in error
      ? String(error.message) : "";
    const code = /^(?:GMAIL_(?:AUTH_REVOKED|CREDENTIALS_MISSING|TIMEOUT|REQUEST_FAILED)|GMAIL_HTTP_[45]\d{2})$/.test(message)
      ? message : "GMAIL_REQUEST_FAILED";
    console.error("CAD_POLL_FETCH_FAILED", { code, durationMs: Date.now() - startedAt });
    return NextResponse.json({ ok: false, code, error: "Dispatch sync is temporarily unavailable." }, {
      status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }
}
