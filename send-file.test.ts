import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareSendFileBytes } from "./send-file.js";

/** Read a flag's value out of an argv array, asserting both the flag and its value exist
 *  (keeps the test type-safe under noUncheckedIndexedAccess). */
function flagValue(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  assert.ok(i >= 0, `argv missing ${flag}`);
  const v = argv[i + 1];
  assert.ok(v !== undefined, `argv missing value for ${flag}`);
  return v;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "wacli-upload-test-"));
}

void test("decodes base64, writes a temp file, builds argv, and cleans up", () => {
  const dir = freshDir();
  try {
    const content = Buffer.from("hello world").toString("base64");
    const { argv, cleanup } = prepareSendFileBytes(
      { to: "123@s.whatsapp.net", content_base64: content, filename: "note.txt", caption: "hi" },
      { uploadDir: dir, maxUploadBytes: 1024 },
    );
    assert.equal(argv[0], "send");
    assert.equal(argv[1], "file");
    assert.equal(flagValue(argv, "--to"), "123@s.whatsapp.net");
    const tmp = flagValue(argv, "--file");
    assert.ok(tmp.startsWith(dir), "temp must live inside uploadDir");
    assert.equal(flagValue(argv, "--filename"), "note.txt");
    assert.equal(flagValue(argv, "--caption"), "hi");
    assert.ok(existsSync(tmp), "temp file should exist after prepare");
    cleanup();
    assert.ok(!existsSync(tmp), "temp file should be gone after cleanup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("rejects content larger than maxUploadBytes without leaving a temp file", () => {
  const dir = freshDir();
  try {
    const content = Buffer.from("x".repeat(100)).toString("base64");
    assert.throws(
      () =>
        prepareSendFileBytes(
          { to: "t", content_base64: content, filename: "big.bin" },
          { uploadDir: dir, maxUploadBytes: 10 },
        ),
      /exceeds max upload size/,
    );
    assert.equal(readdirSync(dir).length, 0, "no temp file should be written on oversize");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("rejects invalid base64", () => {
  const dir = freshDir();
  try {
    assert.throws(
      () =>
        prepareSendFileBytes(
          { to: "t", content_base64: "not_base64!!", filename: "x.txt" },
          { uploadDir: dir, maxUploadBytes: 1024 },
        ),
      /not valid base64/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("rejects content that decodes to zero bytes", () => {
  const dir = freshDir();
  try {
    assert.throws(
      () =>
        prepareSendFileBytes(
          { to: "t", content_base64: "", filename: "x.txt" },
          { uploadDir: dir, maxUploadBytes: 1024 },
        ),
      /0 bytes/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("strips path traversal from filename (basename only)", () => {
  const dir = freshDir();
  try {
    const content = Buffer.from("data").toString("base64");
    const { argv, cleanup } = prepareSendFileBytes(
      { to: "t", content_base64: content, filename: "../../etc/passwd" },
      { uploadDir: dir, maxUploadBytes: 1024 },
    );
    const tmp = flagValue(argv, "--file");
    assert.ok(tmp.startsWith(dir), "temp must stay inside uploadDir");
    assert.ok(!tmp.includes(".."), "temp path must not contain ..");
    assert.equal(flagValue(argv, "--filename"), "passwd");
    cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
