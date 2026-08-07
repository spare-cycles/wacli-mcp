/**
 * The one rule both halves of this package apply to a `content-disposition` filename.
 *
 * It lives in its own module because it is enforced on both sides of the same boundary, and a
 * security predicate duplicated in two files is a security predicate that drifts: `implement()`
 * will not put a name that fails it into the parameter a client percent-decodes, and
 * `createClient()` will not report one it read back out of that parameter.
 */

/**
 * Whether a string is a filename a consumer can use.
 *
 * The name comes from the WhatsApp sender, so it is attacker-influenced, and the consumer puts it
 * on a filesystem or into a UI. A path separator makes it a *path* rather than a name — the whole
 * point of `../../etc/passwd` — and `.` and `..` name a directory. A control character is not
 * printed but acted on: a NUL truncates the name for anything with a C string underneath, and a CR
 * or LF splits the line it is logged on.
 *
 * Nothing else is refused. A quote, a semicolon, a space or an accent are ordinary data in a
 * filename; the header quoting they would break is the header's problem, solved where the header is
 * written, not by mangling names.
 */
export function isUsableFilename(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\p{Cc}]/u.test(name);
}
