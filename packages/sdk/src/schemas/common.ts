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

/**
 * The upper bound that separates seconds from milliseconds, taken from the one place in this
 * codebase that already has to tell them apart: `packages/api`'s `whatsapp/ingest.ts:113`, where
 * `MILLISECOND_THRESHOLD = 1e11` decides whether an incoming WhatsApp stamp gets divided by 1000.
 * 1e11 seconds is the year 5138; 1e11 milliseconds was 1973. Duplicated rather than imported —
 * `packages/sdk` depends on nothing but `zod` — but deliberately the same number, because a
 * contract that refused what ingest produces would be worse than no bound at all.
 */
const MILLISECOND_THRESHOLD = 1e11;

/**
 * An instant in the contract: integer **Unix seconds** (Global Constraint 4).
 *
 * The bound is what makes this more than `z.number().int()`. The failure Constraint 4 exists to
 * prevent is a `Date.now()` that never got divided — and `Date.now()` is an integer, so `.int()`
 * alone accepts it and the row surfaces as a message dated 55 000 AD, visible only once a model
 * reads it back. Above the threshold a value can only be milliseconds; below it, it is a second
 * stamp that could plausibly be real, and the schema has no business judging it further.
 *
 * Exclusive, not `.max()`: 1e11 itself is already milliseconds.
 *
 * Applied to every stamp of something that happened, and to `MediaLink.expiresAt`, whose deadline
 * is minutes away. Deliberately **not** to `Chat.mutedUntil`; see the note at its declaration.
 */
export const epochSeconds = z.number().int().lt(MILLISECOND_THRESHOLD);
