import { z } from "zod";

/**
 * One page of a listing.
 *
 * `nextCursor` is a plain opaque string, never a branded type and never a decoded offset. The
 * encoding belongs to the API alone: a client that parsed it would freeze today's base64url offset
 * into the contract, and the whole point of an opaque token is that it can become a keyset cursor
 * without a schema change. `null` means this was the last page.
 */
export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ nextCursor: z.string().nullable(), items: z.array(item) });
