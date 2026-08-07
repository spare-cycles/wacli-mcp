/**
 * The one rule both halves of this package apply to a `content-disposition` filename, and the one
 * encoder that is allowed to act on a name it accepts.
 *
 * It lives in its own module because it is enforced on both sides of the same boundary, and a
 * security predicate duplicated in two files is a security predicate that drifts: `implement()`
 * will not put a name that fails it into the parameter a client percent-decodes, and
 * `createClient()` will not report one it read back out of that parameter.
 */

/**
 * The longest name this package will carry, in UTF-8 bytes.
 *
 * 255 is the component limit on ext4, APFS and NTFS alike, so it is the length a consumer can
 * actually write. It is also the only bound anything here puts on this header: `filename*=`
 * percent-encodes, which is up to seven bytes per accented or emoji character where the plain
 * parameter was one, and the name is chosen by the WhatsApp sender through a protobuf string field
 * the protocol does not bound. Unbounded, a 1 KB name became an 8 KB response header — past the
 * default response-header buffer of a reverse proxy, so a sender could turn their own download
 * into a 502 for the operator.
 */
const MAX_FILENAME_BYTES = 255;

/**
 * The Win32 device names, which the object manager resolves before any filesystem sees them.
 *
 * With or without an extension: `NUL.txt` is the null device, so writing a downloaded attachment to
 * it succeeds and keeps nothing. Only `COM1`–`COM9` and `LPT1`–`LPT9` are devices, which is why the
 * digit is not repeated — `COM10` is an ordinary file.
 */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

const utf8 = new TextEncoder();

/**
 * Whether a string is a filename a consumer can use.
 *
 * The name comes from the WhatsApp sender, so it is attacker-influenced, and the consumer puts it
 * on a filesystem or into a UI. What is refused is anything that stops the string being *a name in
 * a directory*:
 *
 * - `/` and `\` make it a path — the whole point of `../../etc/passwd`. So does `:`, on two counts:
 *   `C:evil.exe` resolves against a drive's current directory on Win32 and `a:b` names an alternate
 *   data stream on it, and the classic Mac namespace macOS still renders in Finder reads it as the
 *   separator. A colon in a name is therefore folded out of the header rather than carried.
 * - `.` and `..` name a directory, and so do `.. ` and `..\u00a0`: Win32 strips trailing dots and
 *   spaces from the last component, so the check has to run on the trimmed name or it checks a
 *   string the filesystem never sees.
 * - A Win32 device name is not a file at all; see `RESERVED_DEVICE`.
 * - A control character is not printed but acted on: a NUL truncates the name for anything with a C
 *   string underneath, and a CR or LF splits the line it is logged on.
 * - An unpaired surrogate is not text. It survives `JSON.parse('"\\ud800"')`, and `BinaryPayload`'s
 *   filename is a plain `string`, so it reaches here — where `encodeURIComponent` raises `URIError`
 *   on it. See `extendedFilenameValue`.
 * - A bidi control (U+202E RIGHT-TO-LEFT OVERRIDE and its eight siblings) reorders what is
 *   *rendered* without changing what is *stored*: `photo\u202egnp.exe` is displayed as
 *   `photoexe.png` by every bidi-aware file manager and terminal, which is the oldest filename
 *   spoof there is. Refusing it costs a name almost nothing — the header's plain parameter still
 *   carries the ASCII fold, `photo_gnp.exe` — because no legitimate filename needs explicit
 *   reordering; Arabic and Hebrew names render right-to-left from their own letters.
 * - More than 255 UTF-8 bytes; see `MAX_FILENAME_BYTES`.
 *
 * **The rest of `\p{Cf}` is deliberately allowed**, and this is the trade to weigh before tightening
 * the line above: `\p{Cf}` also covers U+200D ZERO WIDTH JOINER, which is how a multi-person or
 * flag emoji is spelled, and a WhatsApp filename with an emoji in it is ordinary rather than
 * suspicious. Refusing the whole category to catch the overrides would lose those names outright.
 * `Bidi_Control` is the subset that has no legitimate use in a name, so it is the subset refused.
 *
 * Nothing else is refused. A quote, a semicolon, a space or an accent are ordinary data in a
 * filename; the header quoting they would break is the header's problem, solved where the header is
 * written, not by mangling names.
 *
 * And two things this does **not** make safe, because no filename predicate can. A name is not an
 * argv element: `-rf` passes, and so would `-x.pdf`, so a consumer that hands one to a program
 * needs `--` or an exec API that takes an array — refusing a leading `-` would lose ordinary names
 * and still not make the rest safe. A name is not markup or SQL either; escaping belongs to
 * whatever renders or stores it.
 */
export function isUsableFilename(name: string): boolean {
  // The bound goes first, and not only because it is the cheapest test: UTF-8 is never shorter than
  // UTF-16 in units, so `name.length` alone refuses everything past the limit, and that bounds the
  // work every line below does on a name an outsider chose. `[\s.]+$` backtracks quadratically over
  // a run of trailing dots — 1.4 s for a 60 KB one — and the encoding allocates.
  if (name.length > MAX_FILENAME_BYTES || utf8.encode(name).length > MAX_FILENAME_BYTES) return false;
  const trimmed = name.replace(/[\s.]+$/u, "");
  if (trimmed === "" || RESERVED_DEVICE.test(trimmed)) return false;
  return !/[/\\:\p{Cc}\p{Surrogate}\p{Bidi_Control}]/u.test(name);
}

/**
 * The RFC 8187 `ext-value` for a name, or `undefined` when the name is not one to hand on.
 *
 * The guard is *inside* this function, and that is the whole reason it exists rather than being two
 * lines at the call site. `encodeURIComponent` throws `URIError: URI malformed` on an unpaired
 * surrogate, so a call site that checked `isUsableFilename` and then encoded was still one
 * `\ud800` away from a `URIError` escaping a media download that had already succeeded — the guard
 * did not cover what the encoder rejects, and nothing made the two agree. Teaching the predicate
 * about surrogates fixes that one string; making the encoder unreachable except through the
 * predicate fixes the relationship, so the next character class either function learns cannot open
 * the same gap. This returns a value or nothing; it never throws, for any input.
 */
export function extendedFilenameValue(name: string): string | undefined {
  if (!isUsableFilename(name)) return undefined;
  // `encodeURIComponent` leaves `!'()*` alone — legal in a URI component, not in RFC 8187's
  // `attr-char`, and `'` in particular is the delimiter the charset and language tags are written
  // with, so an apostrophe in a name would look like the end of one.
  return encodeURIComponent(name).replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
