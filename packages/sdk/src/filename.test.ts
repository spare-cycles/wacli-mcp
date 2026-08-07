import { strict as assert } from "node:assert";
import { test } from "node:test";

import { extendedFilenameValue, isUsableFilename } from "./filename.js";

// --- the pairing between the rule and the encoder ---------------------------------------------------

void test("the rule refuses exactly what the encoder cannot carry, over an adversarial corpus", () => {
  // `contentDisposition()` checked `isUsableFilename` and then called `encodeURIComponent`, which
  // raises `URIError: URI malformed` on an unpaired surrogate — a name the predicate called usable.
  // The throw escaped `implement()` and killed a media download that had already succeeded, on both
  // binary routes including the unauthenticated one. One string is not the bug; the guard and the
  // encoder disagreeing about their domain is, so this asserts the relationship rather than the
  // string, over 40,000 names built from every character class either of them reacts to.
  //
  // What it proves, precisely, because the looser claim is what let it look stronger than it was:
  // the encoder is **total** over the rule's domain — it never throws, for any input — its output is
  // a strict subset of RFC 8187 `attr-char`, and what it emits decodes back to the name it was
  // given. It emits for exactly the names the rule accepts, and that equality is checked against
  // `documentedRule` below rather than against `isUsableFilename`: `extendedFilenameValue` *calls*
  // `isUsableFilename`, so comparing the two is a tautology that can only fail by the encoder
  // throwing, and six of the rule's seven clauses — including the `/` and `\` refusal that closes
  // traversal — were invisible to it. Two limits of the corpus, so the next reader does not read
  // more into it: names are 0–5 units long, so the 255-byte bound is unreachable from here and is
  // pinned by its own test below, and roughly one case in six is the empty string.
  //
  // The rule as *documented*, spelled from the doc comment rather than from the implementation's
  // regexes: code points and explicit sets, so a clause quietly dropped from either side is a
  // disagreement here. It is deliberately a second spelling and not a second source of truth — no
  // production code may import it, and where the two disagree the doc comment is the arbiter.
  const BIDI_CONTROL = new Set([
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ]);
  // ECMAScript `\s`, enumerated: the trailing run Win32 strips is `[\s.]`, and `\s` is more than a
  // space — U+00A0 is in the corpus below precisely because `..\u00a0` trims to `..`.
  const WHITESPACE = new Set([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
  ]);
  const DEVICES = new Set([
    "con",
    "prn",
    "aux",
    "nul",
    ..."123456789¹²³".split("").flatMap((d) => [`com${d}`, `lpt${d}`]),
  ]);
  const documentedRule = (name: string): boolean => {
    // Bytes, not units. `name.length > 255` in the implementation is a short-circuit for the same
    // condition — UTF-8 is never shorter than UTF-16 in units — so leaving it out here checks that.
    if (new TextEncoder().encode(name).length > 255) return false;
    let end = name.length;
    while (end > 0) {
      const unit = name.charCodeAt(end - 1);
      if (unit !== 0x2e && !WHITESPACE.has(unit)) break;
      end -= 1;
    }
    const trimmed = name.slice(0, end);
    if (trimmed === "") return false;
    if (DEVICES.has((trimmed.split(".")[0] ?? "").toLowerCase())) return false;
    // `for…of` yields a lone surrogate as itself and a well-formed pair as one astral code point,
    // which is exactly what `\p{Surrogate}` means under the `u` flag.
    for (const character of name) {
      const code = character.codePointAt(0) ?? 0;
      if (character === "/" || character === "\\" || character === ":") return false;
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false; // \p{Cc}
      if (code >= 0xd800 && code <= 0xdfff) return false;
      if (BIDI_CONTROL.has(code)) return false;
    }
    return true;
  };

  // Every class either function reacts to, one unit at a time — an array rather than a spread
  // string, so a lone surrogate stays lone instead of being recombined by code-point iteration.
  const alphabet = [
    "a",
    "b",
    "c",
    "é",
    "😀",
    ".",
    "-",
    " ",
    "_",
    "~",
    "%",
    "'",
    "(",
    ")",
    "!",
    "*",
    "/",
    "\\",
    ":",
    ";",
    '"', // path separators and the quoted-string metacharacters
    "\u0000",
    "\r",
    "\n", // \p{Cc}
    "\ud800",
    "\udfff",
    "\ud83d",
    "\ude00", // surrogates, lone and (by adjacency) paired
    "\u202e",
    "\u200f",
    "\u2066", // \p{Bidi_Control}
    "\u200d",
    "\u00ad", // the rest of \p{Cf}, which is deliberately allowed
    "\u00a0",
    "..",
    "nul",
    "con",
    "aux",
    "com1",
    "com0",
    "\u00b9", // device stems, so the reserved-name clause is reachable from this corpus at all
  ];
  // Deterministic: a fuzz that reruns a different corpus reports a different suite every time.
  let state = 0x2545f491;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  // Only `[A-Za-z0-9._~-]` survives `encodeURIComponent` plus the `['()!*]` post-pass, and all four
  // of those are RFC 8187 `attr-char`. Anything else in the output would be a parameter delimiter.
  const attrChar = /^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})*$/;
  let usable = 0;
  for (let i = 0; i < 40_000; i += 1) {
    let name = "";
    for (let unit = next() % 6; unit > 0; unit -= 1) name += alphabet[next() % alphabet.length] ?? "";
    const encoded = extendedFilenameValue(name);
    assert.equal(
      encoded !== undefined,
      documentedRule(name),
      `encoder and documented rule disagree on ${JSON.stringify(name)}`,
    );
    assert.equal(isUsableFilename(name), documentedRule(name), `rule and its doc disagree on ${JSON.stringify(name)}`);
    if (encoded === undefined) continue;
    usable += 1;
    assert.match(encoded, attrChar, `${JSON.stringify(name)} encoded outside attr-char`);
    assert.equal(decodeURIComponent(encoded), name);
  }
  // The corpus has to reach both answers, or a rule that refused everything would pass this.
  assert.ok(usable > 1000 && usable < 39_000, `${usable} of 40000 usable`);
});

void test("an unpaired surrogate is refused rather than thrown on", () => {
  for (const name of ["lone\ud800.pdf", "tail\udfff", "\ud83d"]) {
    assert.equal(isUsableFilename(name), false);
    assert.equal(extendedFilenameValue(name), undefined);
  }
  // A well-formed astral character is not a surrogate, and is carried.
  assert.equal(extendedFilenameValue("😀.pdf"), "%F0%9F%98%80.pdf");
});

// --- what counts as a name --------------------------------------------------------------------------

void test("a name that is a directory once Win32 has trimmed it is not a name", () => {
  // Win32 strips trailing dots and spaces from the last path component, so `.. ` reaches
  // `CreateFile` as `..` — the exact string the explicit check exists to refuse.
  for (const name of ["..", ".. ", "..\u00a0", "...", ".", ". ", "   ", ""]) {
    assert.equal(isUsableFilename(name), false, JSON.stringify(name));
  }
  // The trimming is for the traversal check only: a name that still names something after it keeps
  // its trailing dot or space, because losing the whole name costs more than the platform's trim.
  for (const name of ["a.", "a ", "a..", "..a"]) {
    assert.equal(isUsableFilename(name), true, JSON.stringify(name));
  }
});

void test("a colon is a path separator too, on the two platforms that read it as one", () => {
  // `C:evil.exe` resolves against a drive's current directory on Win32 and `a:b` writes to an
  // alternate data stream of `a`; Finder still renders `:` as `/`.
  assert.equal(isUsableFilename("a:b"), false);
  assert.equal(isUsableFilename("C:evil.exe"), false);
});

void test("a Win32 device name is not a file, so it is not a filename", () => {
  // Writing an attachment to `NUL.txt` succeeds and keeps nothing; `CON` is the console. The list is
  // Microsoft's, and `\d` was neither half of it: it refused `COM0` and `LPT0`, which are ordinary
  // files, and missed `COM¹`, `COM²`, `COM³`, `LPT¹`, `LPT²`, `LPT³`, which Win32 resolves to the
  // same devices as their ASCII spellings.
  for (const name of [
    "CON",
    "nul",
    "NUL.txt",
    "com1",
    "LPT9.pdf",
    "aux",
    "CON ",
    "COM\u00b9",
    "lpt\u00b3.txt",
    "COM\u00b2",
  ]) {
    assert.equal(isUsableFilename(name), false, JSON.stringify(name));
  }
  // Only the nine numbered devices, and only as the whole stem. `com0` names nothing on Win32, so
  // refusing it cost an ordinary name its filename for a device that does not exist.
  for (const name of ["com10", "console.txt", "nullify.pdf", "aux-2024.pdf", "com0.pdf", "lpt0.txt", "com0"]) {
    assert.equal(isUsableFilename(name), true, name);
  }
});

void test("a bidi override is refused and a zero-width joiner is not, which is the trade", () => {
  // `photo\u202egnp.exe` renders as `photoexe.png` in any bidi-aware UI while ending in `.exe`.
  // Refusing all of `\p{Cf}` would take the ZWJ with it, and a WhatsApp filename with a
  // multi-person emoji in it is ordinary — so the refusal is scoped to `Bidi_Control`.
  for (const name of ["photo\u202egnp.exe", "a\u200fb.pdf", "a\u2066b.pdf", "a\u061cb.pdf"]) {
    assert.equal(isUsableFilename(name), false, JSON.stringify(name));
  }
  assert.equal(isUsableFilename("👨\u200d👩\u200d👧.png"), true);
  assert.equal(isUsableFilename("soft\u00adhyphen.pdf"), true);
});

void test("Bidi_Control is twelve code points, and all twelve are what the trade gives up", () => {
  // The doc comment used to call it "U+202E and its eight siblings", which is three short: the
  // class also carries the directional *marks* LRM, RLM and ALM, and those are not reordering
  // controls — an RTL user inserts one to fix digit and punctuation order in a name that needs no
  // reordering at all. The trade is taken anyway and the cost is real, so the class is enumerated
  // here rather than described: whichever way a later round decides it, the comment and the runtime
  // cannot drift apart without this failing.
  const controls: number[] = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (/\p{Bidi_Control}/u.test(String.fromCodePoint(code))) controls.push(code);
  }
  assert.deepEqual(
    controls,
    [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069],
  );
  for (const code of controls)
    assert.equal(isUsableFilename(`a${String.fromCodePoint(code)}b.pdf`), false, code.toString(16));
  // And the cost, measured rather than assumed: an RTL name with a mark keeps only its ASCII fold.
  assert.equal(isUsableFilename("مرحبا.pdf"), true);
  assert.equal(isUsableFilename("مرحبا\u200f.pdf"), false);
});

void test("a name is bounded at 255 UTF-8 bytes, because that is what a consumer can write", () => {
  // Without a bound, `filename*=` percent-encoding turned a 1 KB accented name into an 8 KB
  // response header — past a reverse proxy's default buffer, on a name the sender chooses.
  assert.equal(isUsableFilename("a".repeat(255)), true);
  assert.equal(isUsableFilename("a".repeat(256)), false);
  // Bytes, not UTF-16 units: 128 accented characters are 256 bytes and would not fit a directory
  // entry on ext4 or APFS, though the string is only 128 units long.
  assert.equal(isUsableFilename("é".repeat(127) + "a"), true);
  assert.equal(isUsableFilename("é".repeat(128)), false);
});

void test("the bound is checked before the trim, so a huge name is refused rather than chewed on", () => {
  // `[\s.]+$` backtracks quadratically: a 60 KB run of trailing dots takes 1.4 s to trim and the
  // name is refused at the end of it anyway. The order of the two checks is the only thing between
  // a sender's filename and a CPU stall, and it is invisible in the verdict — hence a clock.
  //
  // The budget is set from the *mutation* margin, not the pass margin, because that is the number the
  // assertion's value depends on. As written the two calls below cost 0.66 ms of CPU — the length
  // check refuses both before any regex runs — and 1366 ms with the bound and the trim swapped back,
  // which is the mutation this test exists to catch. 50 ms fails that mutant by ~27x.
  //
  // It measures **CPU** time, not wall time, and that is load-bearing rather than fastidious. The
  // timed region does essentially no work, so a wall clock here measures the scheduler, not the
  // computation: under CFS quota throttling (a container with `cpu: 500m`, ordinary on Kubernetes
  // runners) an exhausted quota freezes the whole cgroup until the next 100 ms period — measured
  // excursions of 80 ms at `--cpus=0.5` and 98 ms at `--cpus=0.25`, against a 50 ms budget, while
  // p99 stayed at 0.03 ms. `process.cpuUsage()` does not advance while descheduled, so it keeps the
  // sensitivity the budget was tightened for without the flake — whose failure message would have
  // read as a security regression rather than as noise.
  const started = process.cpuUsage();
  assert.equal(isUsableFilename(".".repeat(60_000) + "a"), false);
  assert.equal(isUsableFilename("é".repeat(60_000)), false);
  const spent = process.cpuUsage(started);
  const ms = (spent.user + spent.system) / 1000;
  assert.ok(ms < 50, `${ms}ms of CPU to refuse two oversized names`);
});
