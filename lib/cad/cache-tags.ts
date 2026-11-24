import { revalidateTag } from "next/cache";

export const CAD_PUBLIC_TAG = "cad-public";

export function invalidateCadPublicCache(): void {
  // Route handlers need immediate expiration after a write. The next reader
  // refreshes the shared snapshot; the hourly TTL is only a fallback.
  revalidateTag(CAD_PUBLIC_TAG, { expire: 0 });
}
