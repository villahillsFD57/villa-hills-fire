/**
 * GET /api/cad/latest
 * Returns the 10 most recent calls (public — no sensitive data).
 */

import { NextResponse } from "next/server";
import { getCachedCadSnapshot } from "@/lib/cad/public-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const snapshot = await getCachedCadSnapshot();
    return NextResponse.json(snapshot.latest, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("CAD_PUBLIC_READ_FAILED", { endpoint: "latest" });
    return NextResponse.json({ error: "Dispatch updates are temporarily unavailable." }, {
      status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
}
