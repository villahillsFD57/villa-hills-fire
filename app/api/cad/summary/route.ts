import { NextResponse } from "next/server";
import { getCachedCadSummary } from "@/lib/cad/public-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    return NextResponse.json(await getCachedCadSummary(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    console.error("CAD_PUBLIC_READ_FAILED", { endpoint: "summary" });
    return NextResponse.json({ error: "Dispatch updates are temporarily unavailable." }, {
      status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
}
