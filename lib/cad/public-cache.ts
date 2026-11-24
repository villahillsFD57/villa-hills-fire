import { unstable_cache } from "next/cache";
import { currentChicagoYear, getCallsForYear, getPublicCadSnapshot } from "./db";
import { CAD_PUBLIC_TAG } from "./cache-tags";

// This is Next's shared Data Cache, not a per-process JavaScript variable.
// Repeated visitors reuse one snapshot instead of querying D1 on every poll.
// Every successful call mutation invalidates the tag immediately.
let retryDatabaseAfter = 0;

async function readWithBackoff<T>(read: () => Promise<T>): Promise<T> {
  if (Date.now() < retryDatabaseAfter) throw new Error("CAD_DATABASE_UNAVAILABLE");
  try {
    return await read();
  } catch {
    // Failed reads never become an empty snapshot. This short backoff avoids
    // repeated quota/auth/network attempts from a warm server instance.
    retryDatabaseAfter = Date.now() + 60_000;
    throw new Error("CAD_DATABASE_UNAVAILABLE");
  }
}

const readSnapshot = unstable_cache(
  (year: number) => readWithBackoff(() => getPublicCadSnapshot(year)),
  ["cad-d1-public-snapshot-v1"], {
  revalidate: 3600, tags: [CAD_PUBLIC_TAG],
});
const readLog = unstable_cache(
  (year: number) => readWithBackoff(() => getCallsForYear(year)),
  ["cad-d1-public-log-v1"], {
  revalidate: 3600, tags: [CAD_PUBLIC_TAG],
});

export async function getCachedCadSnapshot() {
  return readSnapshot(currentChicagoYear());
}

export async function getCachedCadSummary() {
  const snapshot = await getCachedCadSnapshot();
  return {
    latest: snapshot.latest[0] ?? null,
    count: snapshot.count,
    countComplete: snapshot.countComplete,
    year: snapshot.year,
    updatedAt: snapshot.updatedAt,
  };
}

export async function getCachedCadLog() {
  return readLog(currentChicagoYear());
}
