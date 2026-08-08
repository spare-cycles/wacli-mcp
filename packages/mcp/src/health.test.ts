/**
 * The two consumers of `/health`, and the one field they are not allowed to disagree about.
 *
 * `ok` is the API's own value and means only "the account is not logged out" — the sentence
 * `whatsapp_health`'s description has always carried. Reachability lives in `api` and nowhere else.
 * Where the two consumers *do* diverge is what happens when no report comes back: the container
 * probe answers `ok: false`, because an MCP that cannot reach its API is unhealthy, while the tool
 * gets the failure object so it can answer `isError` rather than a report with invented fields.
 *
 * Every test drives a real `createClient` over an injected `fetch`, so the classification of a
 * failure is the SDK's, not a fake's: whether a dead socket is `ApiUnreachableError` and a 500 is
 * not is precisely what `api.reachable` reports.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ApiUnreachableError, createClient, type HealthReport } from "whatsapp-api-sdk";

import { loadConfig } from "./config.js";
import type { ToolContext } from "./context.js";
import { buildProbe, fetchApiHealth } from "./health.js";
import { startHttp } from "./http.js";
import { silentLogger } from "./logger.js";
import { describeError } from "./result.js";

const HEALTHY: HealthReport = {
  ok: true,
  connection: "connected",
  needs_pairing: false,
  last_event_age_sec: 3,
  last_connected_at: 1_700_000_000,
  last_message_at: 1_700_000_100,
  self_id: "33611111111@s.whatsapp.net",
  counts: { chats: 4, messages: 900, contacts: 12 },
  schema_version: 4,
  transcription_available: true,
  auto_transcribe: null,
  read_only: false,
};

const API_URL = "http://api.test:8080";

type Over = {
  /** A `fetch` of your own, for the failures a body cannot express. */
  fetch?: typeof globalThis.fetch;
  /** The report the API answers 200 with. */
  health?: HealthReport;
  /** A status other than 200, with a wire-error body. */
  status?: number;
  apiUrl?: string;
};

function ctxWith(over: Over = {}): ToolContext {
  const config = loadConfig({ WHATSAPP_API_URL: over.apiUrl ?? API_URL });
  const doFetch =
    over.fetch ??
    ((): Promise<Response> => {
      const status = over.status ?? 200;
      const body =
        status === 200
          ? JSON.stringify(over.health ?? HEALTHY)
          : JSON.stringify({ error: { code: "internal", name: "Error", message: "the store is on fire" } });
      return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
    });
  const client = createClient({ baseUrl: config.apiUrl, fetch: doFetch });
  return { config, logger: silentLogger(), client };
}

// --- the container probe -------------------------------------------------------------------------

void test("the container probe is unhealthy when the API cannot be reached", async () => {
  const report = await buildProbe(ctxWith({ fetch: () => Promise.reject(new TypeError("fetch failed")) }));

  assert.equal(report.api.reachable, false);
  assert.equal(report.ok, false);
  // And nothing else. Fabricating a `connection`, a `counts` or a `schema_version` the API never
  // returned invents state a model would then reason about.
  assert.deepEqual(Object.keys(report).sort(), ["api", "ok"]);
  assert.equal(report.api.latencyMs, null, "there is no latency to report when nothing answered");
  assert.match(report.api.error ?? "", /ApiUnreachableError/);
});

void test("a disconnected-but-reachable API leaves ok true, exactly as before the split", async () => {
  const report = await buildProbe(ctxWith({ health: { ...HEALTHY, ok: true, connection: "disconnected" } }));

  assert.equal(report.ok, true, "a transient reconnect must not flap the container's health");
  assert.equal(report.api.reachable, true);
});

void test("a logged-out account is the one thing that makes ok false, and the API decides it", async () => {
  const report = await buildProbe(ctxWith({ health: { ...HEALTHY, ok: false, connection: "logged_out" } }));

  assert.equal(report.ok, false);
  assert.equal(report.api.reachable, true, "the API answered; it is WhatsApp that needs a human");
});

void test("the merged report is the API's payload verbatim, plus one key", async () => {
  const report = await buildProbe(ctxWith());

  assert.ok("connection" in report, "the API answered, so this is the merged report");
  assert.deepEqual(Object.keys(report), [...Object.keys(HEALTHY), "api"]);
  const { api, ...rest } = report;
  assert.deepEqual(rest, HEALTHY, "no field of the API's own report is rewritten on the way through");
  assert.equal(api.url, "http://api.test:8080");
});

void test("latency is measured when a report comes back", async () => {
  const report = await buildProbe(ctxWith());

  assert.equal(typeof report.api.latencyMs, "number");
  assert.ok((report.api.latencyMs ?? -1) >= 0);
});

void test("an API that answers badly is reachable, and still not something to report as healthy", async () => {
  // A 500 is the API saying so. Calling that "unreachable" would send an operator to look at DNS
  // and firewalls instead of at the API's own logs — but there is no report, so `ok` cannot be true.
  const report = await buildProbe(ctxWith({ status: 500 }));

  assert.equal(report.ok, false);
  assert.equal(report.api.reachable, true);
  assert.equal(report.api.latencyMs, null);
});

void test("a response the contract cannot parse is reported as a failure, not as a half report", async () => {
  const fetchOdd = (): Promise<Response> =>
    Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
  const report = await buildProbe(ctxWith({ fetch: fetchOdd }));

  assert.equal(report.ok, false);
  assert.equal(report.api.reachable, true, "it answered; it answered something else");
  assert.match(report.api.error ?? "", /ZodError|invalid|required/i);
});

void test("credentials in the base URL never reach the payload", async () => {
  // `loadConfig` refuses such a URL, so this bypasses it: the redaction has to hold on its own,
  // because a payload is not the place to discover that a check moved (Global Constraint 8).
  const ctx = ctxWith();
  const leaky: ToolContext = { ...ctx, config: { ...ctx.config, apiUrl: "http://mcp:hunter2@api.test:8080" } };

  const report = await buildProbe(leaky);

  assert.equal(report.api.url, "http://api.test:8080");
  assert.doesNotMatch(JSON.stringify(report), /hunter2/);
});

void test("the probe never rejects, whatever the client throws", async () => {
  const boom = (): Promise<Response> => {
    throw new RangeError("something no taxonomy covers");
  };
  const report = await buildProbe(ctxWith({ fetch: boom }));

  assert.equal(report.ok, false);
});

// --- the tool's half -----------------------------------------------------------------------------

void test("the tool is handed the failure itself, so its refusal carries the SDK's own words", async () => {
  const health = await fetchApiHealth(ctxWith({ fetch: () => Promise.reject(new TypeError("fetch failed")) }));

  // `assert.equal` narrows the union, so everything below reads the failure branch directly.
  assert.equal(health.kind, "failure");
  // `errorResult` renders exactly this, which is why the object travels rather than a string: the
  // message names the base URL — credentials already stripped by the SDK — which is what an operator
  // reading the model's transcript needs.
  assert.ok(health.error instanceof ApiUnreachableError);
  assert.match(describeError(health.error), /could not reach the API at http:\/\/api\.test:8080/);
});

void test("the tool gets the merged report when the API answers", async () => {
  const health = await fetchApiHealth(ctxWith({ health: { ...HEALTHY, read_only: true } }));

  assert.ok(health.kind === "report");
  assert.equal(health.report.read_only, true);
  assert.equal(health.report.api.reachable, true);
});

// --- the seam startHttp is handed ----------------------------------------------------------------

void test("buildProbe is what the HTTP surface serves on /health", async () => {
  // The probe and the listener are wired in `main.ts`, which nothing else here exercises: this is
  // what proves the payload type fits the seam and that a probe failure is a 200 saying `ok: false`
  // rather than the HTTP layer's 500, which would say nothing about why.
  const ctx = ctxWith({ fetch: () => Promise.reject(new TypeError("fetch failed")) });
  const handle = await startHttp({
    config: { ...ctx.config, port: 0 },
    logger: ctx.logger,
    buildServer: () => Promise.reject(new Error("no session is opened in this test")),
    health: () => buildProbe(ctx),
  });

  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: unknown; api: { reachable: unknown } };
    assert.equal(body.ok, false);
    assert.equal(body.api.reachable, false);
  } finally {
    await handle.close();
  }
});
