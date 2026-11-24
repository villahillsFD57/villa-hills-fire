import { NextResponse } from "next/server";
import { getCachedCadSummary } from "@/lib/cad/public-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Compatibility endpoint for older installed StatusBar clients. */
export async function GET() {
  try {
    // Reuse the same shared snapshot as the current ticker. Old clients must not
    // keep a separate database query running every minute against incidents.
    const { latest } = await getCachedCadSummary();
    const age = latest ? Date.now() - new Date(latest.dispatchDatetime).getTime() : NaN;
    const active = Number.isFinite(age) && age >= 0 && age < 2 * 60 * 60 * 1000;
    return NextResponse.json({
      incident: latest && active ? {
        type: latest.dispatchNature,
        receivedAt: latest.dispatchDatetime,
        location: null,
        units: null,
      } : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("CAD_PUBLIC_READ_FAILED", { endpoint: "legacy" });
    return NextResponse.json({ error: "Dispatch updates are temporarily unavailable." }, {
      status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
}
