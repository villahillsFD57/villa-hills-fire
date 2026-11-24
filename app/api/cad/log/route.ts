/**
 * GET /api/cad/log
 * Returns all calls for the current Chicago calendar year (public).
 */

import { NextResponse } from "next/server";
import { getCachedCadLog } from "@/lib/cad/public-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const calls = await getCachedCadLog();
    return NextResponse.json(calls, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("CAD_PUBLIC_READ_FAILED", { endpoint: "log" });
    return NextResponse.json({ error: "Dispatch updates are temporarily unavailable." }, {
      status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
}
