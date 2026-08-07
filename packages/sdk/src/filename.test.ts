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
  // string: over 40,000 names built from every character class either of them reacts to, the
  // encoder never throws, it emits nothing for exactly the names the rule refuses, and what it does
  // emit decodes back to the name it was given.
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
    assert.equal(encoded !== undefined, isUsableFilename(name), `encoder and rule disagree on ${JSON.stringify(name)}`);
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
  // Writing an attachment to `NUL.txt` succeeds and keeps nothing; `CON` is the console.
  for (const name of ["CON", "nul", "NUL.txt", "com1", "LPT9.pdf", "aux", "CON "]) {
    assert.equal(isUsableFilename(name), false, name);
  }
  // Only the nine numbered devices, and only as the whole stem.
  for (const name of ["com10", "console.txt", "nullify.pdf", "aux-2024.pdf"]) {
    assert.equal(isUsableFilename(name), true, name);
  }
});

void test("a bidi override is refused and a zero-width joiner is not, which is the trade", () => {
  // `photo\u202egnp.exe` renders as `photoexe.png` in any bidi-aware UI while ending in `.exe`.
  // Refusing all of `\p{Cf}` would take the ZWJ with it, and a WhatsApp filename with a
  // multi-person emoji in it is ordinary — so the refusal is scoped to the reordering controls.
  for (const name of ["photo\u202egnp.exe", "a\u200fb.pdf", "a\u2066b.pdf", "a\u061cb.pdf"]) {
    assert.equal(isUsableFilename(name), false, JSON.stringify(name));
  }
  assert.equal(isUsableFilename("👨\u200d👩\u200d👧.png"), true);
  assert.equal(isUsableFilename("soft\u00adhyphen.pdf"), true);
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
  // a sender's filename and a CPU stall, and it is invisible in the verdict — hence a clock. The
  // margin is four orders of magnitude, so the budget is generous rather than tight.
  const started = performance.now();
  assert.equal(isUsableFilename(".".repeat(60_000) + "a"), false);
  assert.equal(isUsableFilename("é".repeat(60_000)), false);
  assert.ok(performance.now() - started < 500, `${performance.now() - started}ms to refuse two oversized names`);
});
