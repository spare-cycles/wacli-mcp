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
 * it succeeds and keeps nothing. The list is Microsoft's, character for character (*Naming Files,
 * Paths, and Namespaces*): `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` and `LPT1`–`LPT9`, each of the
 * numbered pair also spelled with the superscript digit — `COM¹`, `COM²`, `COM³`, `LPT¹`, `LPT²`,
 * `LPT³` — which Win32 resolves to the same device. `\d` was one character too wide in both
 * directions at once: it refused `COM0` and `LPT0`, which are ordinary files, and it missed the
 * three superscripts, which are not. `COM10` is an ordinary file too, which is why the digit is not
 * repeated.
 */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

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
 * - A bidi control reorders what is *rendered* without changing what is *stored*:
 *   `photo\u202egnp.exe` is displayed as `photoexe.png` by every bidi-aware file manager and
 *   terminal, which is the oldest filename spoof there is. `\p{Bidi_Control}` is **twelve** code
 *   points, not the nine that argument covers, and the difference is worth knowing before anyone
 *   trusts the class to be smaller than it is: five embeddings and overrides (U+202A–U+202E), four
 *   isolates (U+2066–U+2069), and three directional *marks* — U+200E LRM, U+200F RLM, U+061C ALM.
 *   All twelve are refused, and the marks are the ones the "no legitimate filename needs explicit
 *   reordering" argument does not reach: a mark does not reorder a run, it sets the resolved
 *   direction of the *neutral* characters beside it, which is something RTL users and RTL-aware
 *   software insert routinely to fix digit and punctuation order inside an otherwise unambiguous
 *   name. So refusing them has a real cost, measured rather than assumed: `مرحبا\u200f.pdf` keeps
 *   only its fold, `filename="______.pdf"`, where `مرحبا.pdf` is carried whole. That is the trade,
 *   and it is taken deliberately, for three reasons. A mark still reorders when the run beside it
 *   is neutral or numeric — a leading RLM sets the direction a name like `\u200f2024.exe` resolves
 *   in, and `exe.2024` is what renders. It is invisible, so a name carrying one is indistinguishable
 *   to a reader from the same name without it, in either direction. And `createClient()` refuses the
 *   same class on the way in, so narrowing here means narrowing what this package will *report* from
 *   a third-party header too — a wider change than the one RTL name it buys back. A name is never
 *   lost outright to this: the fold is still carried, which is the whole point of the fold.
 * - More than 255 UTF-8 bytes; see `MAX_FILENAME_BYTES`.
 *
 * **The rest of `\p{Cf}` is deliberately allowed**, and this is the trade to weigh before tightening
 * the line above: `\p{Cf}` also covers U+200D ZERO WIDTH JOINER, which is how a multi-person or
 * flag emoji is spelled, and a WhatsApp filename with an emoji in it is ordinary rather than
 * suspicious. Refusing the whole category to catch the overrides would lose those names outright.
 * `Bidi_Control` is the subset whose legitimate uses are narrow enough to give up, so it is the
 * subset refused.
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
