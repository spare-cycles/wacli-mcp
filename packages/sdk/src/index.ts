/**
 * The contract both images compile against.
 *
 * One entrypoint, and everything is re-exported by name rather than with `export *`: a star export
 * makes every symbol added to any schema file part of the published surface without anyone deciding
 * that it should be, and `verbatimModuleSyntax` means the type/value split has to be spelled out
 * here anyway.
 */

export {
  API_ERROR_CODES,
  AmbiguousRecipientError,
  ApiError,
  ApiUnreachableError,
  BadRequestError,
  ConversionError,
  MediaUnavailableError,
  MessageNotFoundError,
  MessageRevokedError,
  NotConnectedError,
  NotFoundError,
  NotOwnMessageError,
  RecipientNotFoundError,
  SendPathError,
  TranscriptionError,
  errorFromWire,
  errorToWire,
  wireError,
} from "./errors.js";
export type { ApiErrorCode, ApiErrorOptions, WireError, WireErrorCode } from "./errors.js";

export { Page, epochSeconds } from "./schemas/common.js";

export {
  CONNECTION_STATES,
  CONTRACT_VERSION,
  Capabilities,
  Chat,
  Contact,
  HealthReport,
  MESSAGE_KINDS,
  Message,
  MessageDetail,
  Reaction,
  RecipientCandidate,
  RecipientResolution,
  SearchHit,
  SendResult,
} from "./schemas/domain.js";
export type { ConnectionState, MessageKind } from "./schemas/domain.js";

export {
  JpegDerivative,
  Keyframe,
  KeyframeStrip,
  MediaLink,
  MediaMeta,
  MediaRepresentation,
  MediaSource,
  MediaTranscript,
  PdfExtract,
  Transcript,
} from "./schemas/media.js";

export {
  ChatParams,
  ChatQuery,
  ContactQuery,
  Disposition,
  EditMessageBody,
  GroupQuery,
  LinkTarget,
  MarkReadBody,
  MediaJpegQuery,
  MediaKeyframesQuery,
  MediaLinkQuery,
  MediaRawQuery,
  MessageParams,
  MessageQuery,
  PageQuery,
  ReactBody,
  ResolveRecipientBody,
  SearchQuery,
  SendFileBody,
  SendTextBody,
  TokenParams,
} from "./schemas/requests.js";

export { routes } from "./routes.js";
export type {
  BinaryPayload,
  BinaryResponse,
  HandlerResult,
  JsonResponse,
  Route,
  RouteKey,
  RouteResponse,
  Routes,
} from "./routes.js";

export { implement } from "./server.js";
export type { Handler, Handlers, ImplementOptions, RawRequest, RawResponse, RouteBinding } from "./server.js";

export { createClient } from "./client.js";
export type { ClientMethod, ClientOptions, WhatsAppApiClient } from "./client.js";
