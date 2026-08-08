/**
 * The version this server advertises in its MCP `initialize` response.
 *
 * A constant, not `readFileSync("package.json")`: in the image `dist/` is copied without the
 * manifest beside it, so a runtime read there is a crash on the first connection — and the obvious
 * repair, walking up from `import.meta.url` until a `package.json` turns up, finds a *dependency's*
 * manifest as readily as ours.
 *
 * It is kept in step with `package.json` by `version.test.ts`, which reads the manifest and asserts
 * the two agree, so a bump to one that forgets the other fails the suite rather than shipping a
 * server that lies about which build it is.
 *
 * This is the **MCP's** version and has nothing to do with `CONTRACT_VERSION`, which the SDK owns:
 * one says which build answered, the other says which contract it speaks.
 */
export const VERSION = "1.0.0";
