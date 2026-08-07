/**
 * The contract, as data.
 *
 * Twenty-four operations, each naming its method, its path, the schemas for what it accepts, and
 * what it answers with. Both sides derive from this table and neither may extend it locally: the
 * API's `implement()` takes a handler map that is an exhaustive mapped type over `Routes`, and the
 * MCP's client is `{ [K in keyof Routes]: … }`. So an operation with no handler is a compile error,
 * and an operation absent from this table has no client method at all.
 *
 * The arithmetic, because implementers use it as a checklist: 6 reads + 7 media + 8 writes +
 * `capabilities` + `getHealth` + `fetchSignedMedia` = 24. `routes.test.ts` asserts it.
 *
 * **`getHealth` and `fetchSignedMedia` are in the table although neither is bearer-authenticated.**
 * That is what `auth` is for. It is not decoration: `implement()` returns it on every binding and
 * the API partitions its mount order by it — `public` and `signed` bindings before the bearer gate,
 * `bearer` bindings after. Pulling them out and hand-mounting them would give the same two routes a
 * second, hand-written source of truth, and would leave `client.getHealth()` — which the MCP's
 * `whatsapp_health` calls — with nothing to generate from.
 *
 * **`HandlerResult` and `BinaryPayload` live here rather than in `server.ts`** because both sides
 * need them and the client must not import the server half of the SDK to name its own return type.
 */

import type { z } from "zod";

import { Page } from "./schemas/common.js";
import {
  Capabilities,
  Chat,
  Contact,
  HealthReport,
  Message,
  MessageDetail,
  RecipientResolution,
  SearchHit,
  SendResult,
} from "./schemas/domain.js";
import {
  JpegDerivative,
  KeyframeStrip,
  MediaLink,
  MediaMeta,
  MediaTranscript,
  PdfExtract,
  Transcript,
} from "./schemas/media.js";
import {
  ChatParams,
  ChatQuery,
  ContactQuery,
  EditMessageBody,
  GroupQuery,
  MarkReadBody,
  MediaJpegQuery,
  MediaKeyframesQuery,
  MediaLinkQuery,
  MediaRawQuery,
  MessageParams,
  MessageQuery,
  ReactBody,
  ResolveRecipientBody,
  SearchQuery,
  SendFileBody,
  SendTextBody,
  TokenParams,
} from "./schemas/requests.js";

/** A response Zod can describe, and therefore parse on the way in. */
export type JsonResponse<S extends z.ZodTypeAny> = { kind: "json"; schema: S };

/**
 * A response of bytes.
 *
 * A discriminated union rather than a schema that pretends to cover both: Zod cannot parse bytes,
 * and a binary endpoint typed as though it could is how one ends up with no type-safe result at all.
 */
export type BinaryResponse = { kind: "binary" };

export type RouteResponse = JsonResponse<z.ZodTypeAny> | BinaryResponse;

export type Route = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Express-style, with `:param` segments. The client substitutes them; the API mounts them. */
  path: string;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response: RouteResponse;
  /**
   * Which gate this route sits behind. See the module note: the API partitions its mount order on
   * this value, which is what lets `/health` and the signed download live in this table — and
   * therefore on the generated client — while staying reachable without a token.
   */
  auth: "bearer" | "public" | "signed";
  /**
   * The 2xx a successful handler produces. Defaults to 200; `sendText` and `sendFile` set 201,
   * because they create a resource. Without this field `implement()` has no way to express what
   * the write table pins, and would write 200 for every JSON route. Nothing the MCP does observes
   * the difference — the client treats any 2xx as success — but the API is a product surface with
   * other consumers, and a create that answers 200 is a small lie in the contract.
   *
   * Narrower than the plan's `number`: `implement()` always writes a body, and a 204 under
   * `res.json(result)` would be a no-content status carrying content. The three listed are the
   * only ones this seam can honestly produce.
   */
  successStatus?: 200 | 201 | 202;
};

/**
 * Every operation the API serves.
 *
 * `as const satisfies Record<string, Route>` and not a plain annotation: the annotation would widen
 * every entry to `Route`, `params`/`query`/`body` would each become `z.ZodTypeAny | undefined` on
 * all 24, and the generated handler and client types would lose the only thing they are for.
 * `satisfies` checks each entry against `Route` while keeping what was written.
 */
export const routes = {
  // --- unauthenticated ----------------------------------------------------------------------

  /**
   * The container healthcheck, and `whatsapp_health`'s payload. Public: a probe has no token, and
   * the report is a closed record that names no secret.
   */
  getHealth: {
    method: "GET",
    path: "/health",
    response: { kind: "json", schema: HealthReport },
    auth: "public",
  },

  /**
   * The signed download. Unauthenticated by design — that is what makes a link shareable and
   * usable from an `<img>` without leaking a bearer token into the DOM — and outside `/v1` by path,
   * so no `:chat` pattern can shadow it.
   */
  fetchSignedMedia: {
    method: "GET",
    path: "/media/dl/:token",
    params: TokenParams,
    response: { kind: "binary" },
    auth: "signed",
  },

  // --- meta ---------------------------------------------------------------------------------

  /** What this deployment can do, and what the client may assume. Compared at session build. */
  capabilities: {
    method: "GET",
    path: "/v1/capabilities",
    response: { kind: "json", schema: Capabilities },
    auth: "bearer",
  },

  // --- reads (6) ----------------------------------------------------------------------------

  listChats: {
    method: "GET",
    path: "/v1/chats",
    query: ChatQuery,
    response: { kind: "json", schema: Page(Chat) },
    auth: "bearer",
  },

  listGroups: {
    method: "GET",
    path: "/v1/groups",
    query: GroupQuery,
    response: { kind: "json", schema: Page(Chat) },
    auth: "bearer",
  },

  listContacts: {
    method: "GET",
    path: "/v1/contacts",
    query: ContactQuery,
    response: { kind: "json", schema: Page(Contact) },
    auth: "bearer",
  },

  listMessages: {
    method: "GET",
    path: "/v1/messages",
    query: MessageQuery,
    response: { kind: "json", schema: Page(Message) },
    auth: "bearer",
  },

  /**
   * Declared before `getMessage` for readability only. Express cannot confuse the two: this path
   * has three segments and `/v1/messages/:chat/:id` has four.
   */
  searchMessages: {
    method: "GET",
    path: "/v1/messages/search",
    query: SearchQuery,
    response: { kind: "json", schema: Page(SearchHit) },
    auth: "bearer",
  },

  /**
   * `MessageDetail`, not `Message`: this is the single-message path, and it carries the full
   * per-reactor list that `whatsapp_download_media`'s summary embeds. Returning the list shape here
   * would drop that array with no type to notice, because the field would simply be absent.
   */
  getMessage: {
    method: "GET",
    path: "/v1/messages/:chat/:id",
    params: MessageParams,
    response: { kind: "json", schema: MessageDetail },
    auth: "bearer",
  },

  // --- media (7) ----------------------------------------------------------------------------
  //
  // One route per representation, replacing the design's single `?as=…` endpoint. Two reasons, and
  // both are structural rather than stylistic. A single route whose `response` were
  // `JsonResponse | BinaryResponse` makes `HandlerResult<R>` evaluate to `never`: `R["response"]` is
  // an indexed access, not a naked type parameter, so the union distributes over neither branch of
  // the conditional. And Express does not route on `?as=`, so one path would have carried seven
  // operations past the `method + path` uniqueness invariant that the mount order relies on.

  /** The original bytes. `disposition` is a request, not a guarantee: the API's inline allowlist wins. */
  fetchMedia: {
    method: "GET",
    path: "/v1/media/:chat/:id",
    params: MessageParams,
    query: MediaRawQuery,
    response: { kind: "binary" },
    auth: "bearer",
  },

  /**
   * JSON with base64 bytes rather than a binary response, so `source` — the *original*
   * attachment's size and mimetype — can ride along. Today's download summary reports those on
   * every branch, and a binary response carries nothing but the derivative.
   */
  fetchMediaJpeg: {
    method: "GET",
    path: "/v1/media/:chat/:id/jpeg",
    params: MessageParams,
    query: MediaJpegQuery,
    response: { kind: "json", schema: JpegDerivative },
    auth: "bearer",
  },

  /** Mints a signed URL. Resolves and caches the attachment first, so a bad link fails in front of its author. */
  fetchMediaLink: {
    method: "GET",
    path: "/v1/media/:chat/:id/link",
    params: MessageParams,
    query: MediaLinkQuery,
    response: { kind: "json", schema: MediaLink },
    auth: "bearer",
  },

  fetchMediaKeyframes: {
    method: "GET",
    path: "/v1/media/:chat/:id/keyframes",
    params: MessageParams,
    query: MediaKeyframesQuery,
    response: { kind: "json", schema: KeyframeStrip },
    auth: "bearer",
  },

  fetchMediaText: {
    method: "GET",
    path: "/v1/media/:chat/:id/text",
    params: MessageParams,
    response: { kind: "json", schema: PdfExtract },
    auth: "bearer",
  },

  /** Cache only, and never spends money. Triggering transcription is `transcribe`, a write. */
  fetchMediaTranscript: {
    method: "GET",
    path: "/v1/media/:chat/:id/transcript",
    params: MessageParams,
    response: { kind: "json", schema: MediaTranscript },
    auth: "bearer",
  },

  fetchMediaMeta: {
    method: "GET",
    path: "/v1/media/:chat/:id/meta",
    params: MessageParams,
    response: { kind: "json", schema: MediaMeta },
    auth: "bearer",
  },

  // --- writes (8) ---------------------------------------------------------------------------

  sendText: {
    method: "POST",
    path: "/v1/messages",
    body: SendTextBody,
    response: { kind: "json", schema: SendResult },
    auth: "bearer",
    // A message was created, and the response names it. The other six writes act on one that exists.
    successStatus: 201,
  },

  sendFile: {
    method: "POST",
    path: "/v1/messages/file",
    body: SendFileBody,
    response: { kind: "json", schema: SendResult },
    auth: "bearer",
    successStatus: 201,
  },

  editMessage: {
    method: "PATCH",
    path: "/v1/messages/:chat/:id",
    params: MessageParams,
    body: EditMessageBody,
    response: { kind: "json", schema: SendResult },
    auth: "bearer",
  },

  deleteMessage: {
    method: "DELETE",
    path: "/v1/messages/:chat/:id",
    params: MessageParams,
    response: { kind: "json", schema: SendResult },
    auth: "bearer",
  },

  react: {
    method: "POST",
    path: "/v1/messages/:chat/:id/reaction",
    params: MessageParams,
    body: ReactBody,
    response: { kind: "json", schema: SendResult },
    auth: "bearer",
  },

  /** Costs money and mutates the store, so it is a write and it is synchronous. */
  transcribe: {
    method: "POST",
    path: "/v1/messages/:chat/:id/transcribe",
    params: MessageParams,
    response: { kind: "json", schema: Transcript },
    auth: "bearer",
  },

  markRead: {
    method: "POST",
    path: "/v1/chats/:chat/read",
    params: ChatParams,
    body: MarkReadBody,
    response: { kind: "json", schema: SendResult },
    auth: "bearer",
  },

  resolveRecipient: {
    method: "POST",
    path: "/v1/recipients/resolve",
    body: ResolveRecipientBody,
    response: { kind: "json", schema: RecipientResolution },
    auth: "bearer",
  },
} as const satisfies Record<string, Route>;

export type Routes = typeof routes;

/** The name of one operation. */
export type RouteKey = keyof Routes;

/**
 * What a binary route hands back, on both sides of the wire.
 *
 * `filename` and `disposition` are `?: T | undefined` rather than a bare `?: T`, matching
 * `ApiErrorOptions` in `errors.ts`. Under `exactOptionalPropertyTypes` the bare form refuses an
 * explicit `undefined`, and a handler computing a filename from a nullable row has one — so the
 * strict spelling would buy nothing and cost every producer a conditional spread. Consumers read
 * `!== undefined` either way, which is what makes the two spellings behave identically here.
 */
export type BinaryPayload = {
  bytes: Uint8Array;
  mimeType: string;
  filename?: string | undefined;
  disposition?: "inline" | "attachment" | undefined;
};

/**
 * What one route answers with: the parsed JSON body, or the bytes.
 *
 * This must never collapse to `never`, which is exactly what a route with a union `response` would
 * cause — see the media section above. Each route declares one response kind, so each of these two
 * conditional branches resolves for every entry in the table, and `routes.test.ts` pins both.
 */
export type HandlerResult<R extends Route> =
  R["response"] extends JsonResponse<infer S>
    ? z.infer<S>
    : R["response"] extends BinaryResponse
      ? BinaryPayload
      : never;
