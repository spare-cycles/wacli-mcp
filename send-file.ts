/**
 * Prepare a `wacli send file` invocation from client-supplied base64 content.
 *
 * Kept env-free and side-effect-free at module scope so it is unit-testable in
 * isolation (server.ts has a top-level bootstrap that would start the MCP server
 * on import). The caller owns the env-derived `uploadDir` / `maxUploadBytes` and
 * is responsible for invoking `cleanup()` once the send completes (success or not).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type SendFileBytesInput = {
  to: string;
  content_base64: string;
  filename: string;
  caption?: string;
  pick?: number;
  reply_to?: string;
};

export type PreparedSend = {
  argv: string[];
  cleanup: () => void;
};

// The standard base64 alphabet, padding stripped before this is applied.
const BASE64_ALPHABET_RE = /^[A-Za-z0-9+/]*$/;

export function prepareSendFileBytes(
  input: SendFileBytesInput,
  opts: { uploadDir: string; maxUploadBytes: number },
): PreparedSend {
  // Only ever use the basename: path.basename strips any "../" segments and absolute
  // prefixes, so the temp file always lands directly in uploadDir (no traversal).
  const base = basename(input.filename);
  if (base === "" || base === "." || base === "..") {
    throw new Error(`invalid filename ${JSON.stringify(input.filename)}: must reduce to a basename`);
  }

  // Tolerate wrapped base64 (clients may insert newlines) and optional/absent padding
  // (some clients omit the trailing '='). Reject only genuinely malformed input: chars
  // outside the standard alphabet, or a length that can't be valid base64 (len % 4 === 1).
  const b64 = input.content_base64.replace(/\s/g, "");
  const core = b64.replace(/=+$/, "");
  if (!BASE64_ALPHABET_RE.test(core) || core.length % 4 === 1) {
    throw new Error("content_base64 is not valid base64");
  }

  const buf = Buffer.from(core, "base64");
  if (buf.length === 0) {
    throw new Error("content_base64 decoded to 0 bytes");
  }
  if (buf.length > opts.maxUploadBytes) {
    throw new Error(`file exceeds max upload size (${buf.length} > ${opts.maxUploadBytes} bytes)`);
  }

  // All checks passed — only now touch disk.
  mkdirSync(opts.uploadDir, { recursive: true });
  const tmp = join(opts.uploadDir, `${randomUUID()}-${base}`);
  writeFileSync(tmp, buf);

  // --filename is always the real basename (never the UUID-prefixed temp name) so
  // WhatsApp shows the right name and infers the MIME type from the extension.
  const argv = ["send", "file", "--to", input.to, "--file", tmp, "--filename", base];
  if (input.caption !== undefined) argv.push("--caption", input.caption);
  if (input.pick !== undefined) argv.push("--pick", String(input.pick));
  if (input.reply_to !== undefined) argv.push("--reply-to", input.reply_to);

  const cleanup = (): void => {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort: file may already be gone */
    }
  };

  return { argv, cleanup };
}
