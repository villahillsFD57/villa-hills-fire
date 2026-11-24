import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin/auth";
import { fetchRecoveryPage, validateRecoveryWindow } from "@/lib/cad/gmail-recovery";
import { parseDispatchEmail } from "@/lib/cad/parser";
import { isDuplicate, saveCall } from "@/lib/cad/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const headers = { "Cache-Control": "no-store" };

/** One page only. Retry a failed page before advancing; successful writes deduplicate by Gmail ID. */
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  let input: unknown;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "A JSON recovery window is required." }, { status: 400, headers });
  }
  const window = validateRecoveryWindow(input);
  if (!window) {
    return NextResponse.json({ error: "Use explicit start/end timestamps with timezones, at most 31 days apart, and the returned page token." }, { status: 400, headers });
  }

  const signal = AbortSignal.timeout(45_000);
  const counts = { examined: 0, stored: 0, duplicates: 0, rejected: 0, failed: 0, deferred: 0 };
  try {
    const page = await fetchRecoveryPage(window, signal);
    counts.examined = page.examined;
    counts.rejected = page.rejected;
    counts.failed = page.failures.length;
    for (let index = 0; index < page.emails.length; index++) {
      if (signal.aborted) { counts.deferred = page.emails.length - index; break; }
      const email = page.emails[index];
      const parsed = parseDispatchEmail(email.subject, email.body, email.received);
      if (parsed.status !== "ok") { counts.rejected++; continue; }
      try {
        if (await isDuplicate(email.id, signal)) { counts.duplicates++; continue; }
        await saveCall({
          gmailMessageId: email.id,
          dispatchDatetime: parsed.dispatchDatetime,
          dispatchDate: parsed.dispatchDate,
          dispatchTime: parsed.dispatchTime,
          dispatchNature: parsed.dispatchNature,
          sourceYear: parsed.sourceYear,
        }, signal);
        counts.stored++;
      } catch {
        counts.failed++;
        counts.deferred = page.emails.length - index - 1;
        break;
      }
    }
    const ok = counts.failed === 0 && counts.deferred === 0;
    const nextPageToken = ok ? page.nextPageToken : null;
    // This recovers only the requested window. It cannot certify the full year,
    // missing mailbox history, or the older paused Neon database's call count.
    return NextResponse.json({
      ok, ...counts, start: window.start, end: window.end,
      nextPageToken, retryPageToken: ok ? null : window.pageToken ?? null,
      retryCurrentPage: !ok,
      recoveryWindowComplete: ok && nextPageToken === null,
      historyComplete: false,
    }, { status: ok ? 200 : 503, headers });
  } catch {
    console.error("CAD_RECOVERY_PAGE_FAILED", { examined: counts.examined, stored: counts.stored });
    return NextResponse.json({
      ok: false, error: "Recovery is temporarily unavailable. Retry the same window and page.",
      ...counts, start: window.start, end: window.end,
      nextPageToken: null, retryPageToken: window.pageToken ?? null,
      retryCurrentPage: true, recoveryWindowComplete: false, historyComplete: false,
    }, { status: 503, headers });
  }
}
