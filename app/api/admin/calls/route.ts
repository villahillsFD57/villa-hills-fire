import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin/auth";
import { saveCall, updateCallNature, deleteCall } from "@/lib/cad/db";

export const dynamic = "force-dynamic";

/** Resolve an entered Chicago wall time without using the Vercel server zone. */
function chicagoTimestamp(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const wanted = `${date}T${time}`;
  const target = Date.parse(`${wanted}:00Z`);
  if (!Number.isFinite(target)) return null;
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const local = (stamp: number) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(stamp)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
  let guess = target;
  for (let i = 0; i < 3; i++) guess += target - Date.parse(`${local(guess)}:00Z`);
  return local(guess) === wanted ? new Date(guess).toISOString() : null;
}

function unavailable() {
  return NextResponse.json({ error: "Call storage is temporarily unavailable." }, { status: 503 });
}

export async function POST(req: NextRequest) {
  if (!(await isAdminAuthed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { dispatchDate, dispatchTime, dispatchNature } = await req.json();
  if (typeof dispatchDate !== "string" || typeof dispatchTime !== "string"
      || typeof dispatchNature !== "string" || !dispatchNature.trim() || dispatchNature.trim().length > 160) {
    return NextResponse.json({ error: "Missing or invalid required fields" }, { status: 400 });
  }
  const timestamp = chicagoTimestamp(dispatchDate, dispatchTime);
  if (!timestamp) return NextResponse.json({ error: "Invalid Chicago date or time" }, { status: 400 });
  const [year, month, day] = dispatchDate.split("-");
  try {
    await saveCall({
      gmailMessageId: `manual-${crypto.randomUUID()}`,
      dispatchDatetime: timestamp,
      dispatchDate: `${month}/${day}/${year}`,
      dispatchTime,
      dispatchNature: dispatchNature.trim(),
      sourceYear: Number(year),
    });
    return NextResponse.json({ ok: true });
  } catch { return unavailable(); }
}

export async function PATCH(req: NextRequest) {
  if (!(await isAdminAuthed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, dispatchNature } = await req.json();
  if (typeof id !== "string" || !id || typeof dispatchNature !== "string"
      || !dispatchNature.trim() || dispatchNature.trim().length > 160) {
    return NextResponse.json({ error: "Missing or invalid call fields" }, { status: 400 });
  }
  try {
    await updateCallNature(id, dispatchNature.trim());
    return NextResponse.json({ ok: true });
  } catch { return unavailable(); }
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdminAuthed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await req.json();
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    await deleteCall(id);
    return NextResponse.json({ ok: true });
  } catch { return unavailable(); }
}
