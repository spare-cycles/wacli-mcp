/**
 * Hand-built `WAMessage`-shaped objects for tests. Not production code, and not loaded by it —
 * only `*.test.ts` files and `src/mcp/tools/harness.ts` import this module. Neither ships, and
 * neither does this file: all three are named in `tsconfig.build.json`'s `exclude`, because the
 * `*.test.ts` glob there catches none of them.
 *
 * This file is one of the two sanctioned exceptions to Global Constraint 11 (all raw JID
 * interpretation lives in `src/wa/jid.ts`): it holds JID **literals as data**, which a fixture for
 * a group or a LID conversation cannot avoid. It never *interprets* one.
 */

import type { WAMessage, WAMessageContent, WAMessageKey } from "baileys";

export const FIXTURE_DM = "33612345678@s.whatsapp.net";
export const FIXTURE_GROUP = "120363000000000000@g.us";
export const FIXTURE_LID = "999@lid";
export const FIXTURE_TS = 1_700_000_000;
/** The account under test, for a harness that has to answer `selfId` without a socket. */
export const FIXTURE_SELF = "33600000000@s.whatsapp.net";

/** The options every fixture accepts; each one defaults to a plausible inbound DM. */
export type FixtureOptions = { chat?: string; id?: string; ts?: number; fromMe?: boolean };

function envelope(o: FixtureOptions, message: WAMessageContent, chat = FIXTURE_DM, participant?: string): WAMessage {
  const key: WAMessageKey = { remoteJid: o.chat ?? chat, id: o.id ?? "M1", fromMe: o.fromMe ?? false };
  if (participant !== undefined) key.participant = participant;
  return { key, messageTimestamp: o.ts ?? FIXTURE_TS, message };
}

/** Media fields a real inbound attachment always carries; the media pipeline (Task 10) needs them. */
const MEDIA = {
  fileLength: 1024,
  fileSha256: new Uint8Array([1, 2, 3, 4]),
  mediaKey: new Uint8Array([5, 6, 7, 8]),
  directPath: "/v/t62.0-24/fixture",
  url: "https://mmg.whatsapp.net/fixture",
};

export function textMessage(o: FixtureOptions & { text?: string } = {}): WAMessage {
  return envelope(o, { conversation: o.text ?? "hello" });
}

export function imageMessage(o: FixtureOptions & { caption?: string } = {}): WAMessage {
  return envelope(o, { imageMessage: { ...MEDIA, mimetype: "image/jpeg", caption: o.caption ?? null } });
}

export function videoMessage(o: FixtureOptions & { caption?: string } = {}): WAMessage {
  return envelope(o, { videoMessage: { ...MEDIA, mimetype: "video/mp4", seconds: 12, caption: o.caption ?? null } });
}

export function audioMessage(o: FixtureOptions & { seconds?: number } = {}): WAMessage {
  return envelope(o, {
    audioMessage: { ...MEDIA, mimetype: "audio/ogg; codecs=opus", seconds: o.seconds ?? 7, ptt: true },
  });
}

export function documentMessage(o: FixtureOptions & { caption?: string; fileName?: string } = {}): WAMessage {
  return envelope(o, {
    documentMessage: {
      ...MEDIA,
      mimetype: "application/pdf",
      fileName: o.fileName ?? "fixture.pdf",
      pageCount: 3,
      caption: o.caption ?? null,
    },
  });
}

export function stickerMessage(o: FixtureOptions = {}): WAMessage {
  return envelope(o, { stickerMessage: { ...MEDIA, mimetype: "image/webp", isAnimated: false } });
}

export function extendedTextReply(
  o: FixtureOptions & { text?: string; quotedId?: string; quotedParticipant?: string } = {},
): WAMessage {
  return envelope(o, {
    extendedTextMessage: {
      text: o.text ?? "re",
      contextInfo: {
        stanzaId: o.quotedId ?? "M0",
        participant: o.quotedParticipant ?? FIXTURE_DM,
        quotedMessage: { conversation: "the original" },
      },
    },
  });
}

export function groupMessage(o: FixtureOptions & { participant?: string; text?: string } = {}): WAMessage {
  return envelope(o, { conversation: o.text ?? "hello group" }, FIXTURE_GROUP, o.participant ?? FIXTURE_DM);
}

export function lidMessage(o: FixtureOptions & { text?: string } = {}): WAMessage {
  return envelope(o, { conversation: o.text ?? "hello from a lid" }, FIXTURE_LID);
}

/** A view-once photo: real content behind an envelope a naive switch over `message` would miss. */
export function viewOnceImage(o: FixtureOptions & { caption?: string } = {}): WAMessage {
  return envelope(o, {
    viewOnceMessageV2: { message: { imageMessage: { ...MEDIA, mimetype: "image/jpeg", caption: o.caption ?? null } } },
  });
}

/** A disappearing-message envelope, the other wrapper WhatsApp routinely puts real content in. */
export function ephemeralText(o: FixtureOptions & { text?: string } = {}): WAMessage {
  return envelope(o, { ephemeralMessage: { message: { conversation: o.text ?? "hello" } } });
}
