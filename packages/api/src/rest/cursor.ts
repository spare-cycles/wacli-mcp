/**
 * Pagination cursors: one opaque token, shared by every paginated route.
 *
 * The cursor is an offset, base64url-encoded so callers treat it as opaque rather than doing
 * arithmetic on it. Opaqueness is the point: `Page.nextCursor` is a plain string on the wire and
 * nothing outside this module may decode it, which leaves room to switch to a keyset cursor later
 * without changing a single schema.
 *
 * A malformed cursor is an **error**, never a silent reset to offset 0. Silently restarting a
 * paginated walk from the beginning is how a model ends up looping over page 1 forever, convinced
 * it is making progress. Over HTTP that error is `bad_request`/400 — `rest/errors.ts` maps this
 * class — and it keeps the name `CursorError` on the wire, so what a model reads is unchanged.
 *
 * It lives under `rest/` because the encoding belongs to the API. The in-process MCP tool layer
 * still imports it while the two surfaces run side by side; Task 16 removes that caller, and the
 * encoding is unchanged by the move.
 */

export class CursorError extends Error {
  override name = "CursorError";
}

const MESSAGE =
  "invalid pagination cursor: pass back the `next_cursor` from a previous page verbatim, or omit it to start over";

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

/** The offset a cursor names. 0 when absent; throws `CursorError` on anything malformed. */
export function decodeCursor(c: string | undefined): number {
  if (c === undefined) return 0;
  // The cursor is never echoed back in the error: it is caller-controlled text, and repeating it
  // puts caller-controlled content into the model's context for no diagnostic gain.
  if (c === "") throw new CursorError(MESSAGE);

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
  } catch {
    throw new CursorError(MESSAGE);
  }
  if (typeof parsed !== "object" || parsed === null) throw new CursorError(MESSAGE);

  const offset: unknown = (parsed as { o?: unknown }).o;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new CursorError(MESSAGE);
  return offset;
}
