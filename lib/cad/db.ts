/**
 * Ticker call storage is served by the private Cloudflare Worker + D1 database.
 * The previous Neon database remains untouched as the historical archive.
 * This module never falls back to Neon or sends database credentials to clients.
 */
import { invalidateCadPublicCache } from "./cache-tags";

export interface Call {
  id: string;
  dispatchDatetime: string;
  dispatchDate: string;
  dispatchTime: string;
  dispatchNature: string;
  sourceYear: number;
  createdAt: string;
}

export interface PublicCadSnapshot {
  latest: Call[];
  count: number;
  countComplete: boolean;
  year: number;
  updatedAt: string;
}

export interface NewCall {
  gmailMessageId: string;
  dispatchDatetime: string;
  dispatchDate: string;
  dispatchTime: string;
  dispatchNature: string;
  sourceYear: number;
}

interface PollRun {
  checked?: number;
  stored?: number;
  inboxTotal?: number;
  durationMs?: number;
  error?: string;
}

async function query<T>(operation: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const origin = process.env.CAD_STORE_URL;
  const token = process.env.CAD_STORE_TOKEN;
  if (!origin || !token) throw new Error("CAD_STORE_NOT_CONFIGURED");
  let url: URL;
  try {
    url = new URL("/v1/query", origin);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
  } catch {
    throw new Error("CAD_STORE_URL_INVALID");
  }
  const timeout = AbortSignal.timeout(10_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation, ...params }),
      cache: "no-store",
      redirect: "error",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) throw new Error("CAD_STORE_UNAVAILABLE");
    return await response.json() as T;
  } catch {
    // Never propagate request headers, credentials, response bodies, or raw URLs.
    throw new Error("CAD_STORE_UNAVAILABLE");
  }
}

export function currentChicagoYear(): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric",
  }).format(new Date()));
}

export async function isDuplicate(gmailMessageId: string, signal?: AbortSignal): Promise<boolean> {
  const result = await query<boolean>("duplicate", { gmailMessageId }, signal);
  if (typeof result !== "boolean") throw new Error("CAD_STORE_INVALID_RESPONSE");
  return result;
}

export async function saveCall(data: NewCall, signal?: AbortSignal): Promise<Call> {
  const call = await query<Call>("saveCall", { data }, signal);
  if (!call || typeof call.id !== "string") throw new Error("CAD_STORE_INVALID_RESPONSE");
  invalidateCadPublicCache();
  return call;
}

export async function getPublicCadSnapshot(year: number): Promise<PublicCadSnapshot> {
  const snapshot = await query<PublicCadSnapshot>("snapshot", { year });
  if (!snapshot || !Array.isArray(snapshot.latest) || !Number.isSafeInteger(snapshot.count)
      || snapshot.count < 0 || snapshot.year !== year || typeof snapshot.updatedAt !== "string") {
    throw new Error("CAD_STORE_INVALID_RESPONSE");
  }
  // Never infer that an annual total is complete during migration.
  return { ...snapshot, countComplete: snapshot.countComplete === true };
}

export async function getLatestCalls(limit = 10): Promise<Call[]> {
  return (await getPublicCadSnapshot(currentChicagoYear())).latest.slice(0, Math.min(10, Math.max(0, limit)));
}

export async function getCallsForYear(year: number): Promise<Call[]> {
  const rows = await query<Call[]>("log", { year });
  if (!Array.isArray(rows)) throw new Error("CAD_STORE_INVALID_RESPONSE");
  return rows;
}

export async function getCallsForCurrentYear(): Promise<Call[]> {
  return getCallsForYear(currentChicagoYear());
}

export async function updateCallNature(callId: string, newNature: string): Promise<void> {
  await query("updateCallNature", { callId, newNature });
  invalidateCadPublicCache();
}

export async function deleteCall(callId: string): Promise<void> {
  await query("deleteCall", { callId });
  invalidateCadPublicCache();
}

export async function logPollRun(data: PollRun): Promise<void> {
  try { await query("logPollRun", { data }); }
  catch { console.error("CAD_POLL_HISTORY_WRITE_FAILED"); }
}

export async function getPollHistory(limit = 50): Promise<Array<{
  ranAt: string; checked: number | null; stored: number | null;
  inboxTotal: number | null; durationMs: number | null; error: string | null;
}>> {
  return query("pollHistory", { limit });
}
