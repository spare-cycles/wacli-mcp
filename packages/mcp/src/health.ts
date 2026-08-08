/**
 * The MCP's health: the API's own report, plus whether this process could reach it.
 *
 * **`ok` keeps the API's meaning exactly, and that is a contract requirement rather than a
 * preference.** The API sets `ok: snap.state !== "logged_out"`, and `whatsapp_health`'s own
 * description — unchanged across the split — says "`ok` is false only when the account has been
 * logged out, which needs a human to re-pair." Making `ok` also mean "and the API answered" would
 * silently redefine a field whose own description rules that out. So the reachability of the API is
 * reported in its own object and nowhere else.
 *
 * From there the two consumers diverge, deliberately:
 *
 * | consumer | API reachable | API unreachable |
 * | --- | --- | --- |
 * | the `whatsapp_health` **tool** | the merged report; `ok` is the API's own value | an `isError` result carrying the failure's text — never a report with invented fields |
 * | this process's `GET /health` (the container probe) | `ok` mirrors the API's | `ok: false` — an MCP that cannot reach its API is genuinely unhealthy |
 *
 * Which is why the failure branch answers `{ ok: false, api }` and not a full report: fabricating a
 * `connection`, a `counts` or a `schema_version` the API never returned would be worse than failing,
 * because it invents state a model would then reason about. There is nothing to report but the
 * failure, so that is what is reported.
 *
 * Nothing here can carry a secret. The report is a closed record the API builds, `api.url` is the
 * configured base URL with any userinfo stripped, and `api.error` is a `describeError` line rather
 * than a raw error object (Global Constraint 9).
 */

import { ApiUnreachableError, type HealthReport } from "whatsapp-api-sdk";

import type { ToolContext } from "./context.js";
import { describeError } from "./result.js";

export type ApiReachability = {
  /**
   * Whether the API answered at all — not whether it answered *well*.
   *
   * Only `ApiUnreachableError` clears this. A 500, a 401 or a response the contract cannot parse all
   * mean the API is there and something else is wrong, and reporting those as "unreachable" would
   * send an operator to look at DNS and firewalls instead of at the API's own logs.
   */
  reachable: boolean;
  /** The measured round trip of the `/health` call, or `null` when no report came back. */
  latencyMs: number | null;
  url: string;
  error: string | null;
};

export type McpHealthReport = HealthReport & { api: ApiReachability };

/** What the probe answers when no report came back: the failure, and nothing invented around it. */
export type McpUnreachableReport = { ok: false; api: ApiReachability };

export type McpProbeReport = McpHealthReport | McpUnreachableReport;

/**
 * The API's health as this process sees it — either the merged report, or the error that stopped it.
 *
 * One function for both consumers, so the tool and the container probe can never disagree about
 * whether the API answered. The `error` is handed back rather than rendered because the tool needs
 * the object: `errorResult` is what turns it into the `isError` text the model reads, and it has to
 * be the failure's own words — `ApiUnreachableError`'s message names the base URL, credentials
 * already stripped, which is the one thing an operator reading the model's output needs.
 */
export type ApiHealth =
  { kind: "report"; report: McpHealthReport } | { kind: "failure"; error: unknown; api: ApiReachability };

/**
 * The base URL with any credentials stripped.
 *
 * `loadConfig` already refuses a URL carrying userinfo, so in a running deployment this is the
 * identity — it is here because this value goes into a payload and an error string, and a redaction
 * that depends on a check in another module is one refactor away from not happening. A base that is
 * not a parseable URL is returned unchanged: it cannot carry a userinfo section.
 */
function withoutCredentials(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

export async function fetchApiHealth(ctx: ToolContext): Promise<ApiHealth> {
  const url = withoutCredentials(ctx.config.apiUrl);
  const startedMs = performance.now();
  try {
    const report = await ctx.client.getHealth();
    // Spread first, `api` last: `ok` stays the first key of the payload, which is what a probe
    // reading a truncated body finds.
    return {
      kind: "report",
      report: {
        ...report,
        api: { reachable: true, latencyMs: Math.round(performance.now() - startedMs), url, error: null },
      },
    };
  } catch (err) {
    return {
      kind: "failure",
      error: err,
      api: {
        reachable: !(err instanceof ApiUnreachableError),
        // Not the time spent failing: this field is a latency, and a caller charting it would read
        // a connect timeout as a very slow but healthy API.
        latencyMs: null,
        url,
        error: describeError(err),
      },
    };
  }
}

/**
 * The container probe's payload: the merged report when there is one, `ok: false` when there is not.
 *
 * This is the seam `startHttp`'s `health` dependency is handed, and it never rejects — a probe that
 * throws is answered with the HTTP layer's 500 envelope, which says nothing about *why*.
 */
export async function buildProbe(ctx: ToolContext): Promise<McpProbeReport> {
  const health = await fetchApiHealth(ctx);
  return health.kind === "report" ? health.report : { ok: false, api: health.api };
}
