import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Retired legacy reset URL. Retain the route only to give old callers an explicit
// response; it must never truncate the archive or the current dispatch store.
export async function GET() {
  return NextResponse.json({ error: "This legacy reset endpoint has been retired." }, {
    status: 410, headers: { "Cache-Control": "no-store" },
  });
}
