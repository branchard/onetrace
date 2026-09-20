#!/usr/bin/env bun
/**
 * Synthetic telemetry for the local stack: traces, span events, logs and
 * metrics for a small three-service system, all correlated by trace id.
 *
 * No dependencies. Bun ships fetch and crypto, and Uptrace's OTLP/HTTP
 * receiver accepts plain JSON, so the objects below are the wire format
 * as-is rather than an SDK's rendering of it.
 *
 * Traffic is steady, but the failure rate is not: every DEMO_CYCLE_S seconds
 * the simulated database starts timing out for DEMO_INCIDENT_S seconds. That
 * gives the UI a recurring incident to group errors around instead of a flat
 * background of random failures.
 */

const ENDPOINT = process.env.OTLP_ENDPOINT ?? "http://onetrace:14318";
const TOKEN = process.env.PROJECT_TOKEN ?? "change-me-in-production";

const RATE = positive("DEMO_RATE", 5); // simulated requests per second
const CYCLE_S = positive("DEMO_CYCLE_S", 120);
const INCIDENT_S = positive("DEMO_INCIDENT_S", 30);
const BASE_ERROR_RATE = 0.02;
const INCIDENT_ERROR_RATE = 0.45;

// One POST per signal per second rather than one per request: 5 req/s through
// separate inserts would create five times the parts for ClickHouse to merge,
// which matters when LOW_MEMORY caps the merge pool at 4 threads.
const FLUSH_MS = 1_000;
const METRICS_EVERY_MS = 10_000;

function positive(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// -- OTLP wire types (only the parts used here) --

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };
type KeyValue = { key: string; value: AnyValue };

const str = (key: string, v: string): KeyValue => ({ key, value: { stringValue: v } });
const int = (key: string, v: number): KeyValue => ({ key, value: { intValue: String(v) } });

type SpanEvent = { timeUnixNano: string; name: string; attributes?: KeyValue[] };
type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events?: SpanEvent[];
  status?: { code: number; message?: string };
};
type LogRecord = {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: AnyValue;
  attributes?: KeyValue[];
  traceId?: string;
  spanId?: string;
};

const KIND = { server: 2, client: 3 } as const;
const STATUS = { ok: 1, error: 2 } as const;
// OTel severity numbers; Uptrace files these under log:info / log:warn / log:error.
const SEVERITY = { info: [9, "Info"], warn: [13, "Warn"], error: [17, "Error"] } as const;

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const ns = (ms: number) => String(Math.round(ms * 1e6));
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const jitter = (base: number, spread: number) => base + Math.random() * spread;

// -- The simulated system --

const ROUTES = [
  { route: "/checkout", op: "POST /api/orders", table: "orders", weight: 1 },
  { route: "/products", op: "GET /api/products", table: "products", weight: 3 },
  { route: "/cart", op: "GET /api/cart", table: "carts", weight: 2 },
] as const;
const WEIGHTED = ROUTES.flatMap((r) => Array<typeof r>(r.weight).fill(r));

/** Groups spans and logs by the service that emitted them: one OTLP resource each. */
class Batch {
  private spans = new Map<string, Span[]>();
  private logs = new Map<string, LogRecord[]>();

  span(service: string, span: Span) {
    push(this.spans, service, span);
  }
  log(service: string, log: LogRecord) {
    push(this.logs, service, log);
  }

  drain() {
    const spans = [...this.spans];
    const logs = [...this.logs];
    this.spans.clear();
    this.logs.clear();
    return { spans, logs };
  }
}

function push<T>(m: Map<string, T[]>, key: string, v: T) {
  const list = m.get(key);
  if (list) list.push(v);
  else m.set(key, [v]);
}

const resource = (service: string) => ({
  attributes: [
    str("service.name", service),
    str("service.version", "1.4.2"),
    str("deployment.environment", "demo"),
  ],
});

/**
 * One simulated user request: a frontend span, the api span it calls, and the
 * db/cache client spans the api makes. On failure the db times out, the error
 * propagates up the three spans, and an `exception` span event is attached —
 * which Uptrace turns into an error log of its own.
 */
function simulateRequest(batch: Batch, nowMs: number, failing: boolean) {
  const { route, op, table } = pick(WEIGHTED);
  const traceId = hex(16);
  const frontendId = hex(8);
  const apiId = hex(8);

  const cacheMs = jitter(1, 3);
  const dbMs = failing ? jitter(2_000, 500) : jitter(8, 40);
  const apiMs = cacheMs + dbMs + jitter(3, 8);
  const frontendMs = apiMs + jitter(4, 10);

  const cacheId = hex(8);
  batch.span("api", {
    traceId,
    spanId: cacheId,
    parentSpanId: apiId,
    name: "GET session",
    kind: KIND.client,
    startTimeUnixNano: ns(nowMs),
    endTimeUnixNano: ns(nowMs + cacheMs),
    attributes: [str("db.system", "redis"), str("db.operation", "GET")],
    status: { code: STATUS.ok },
  });

  const dbStart = nowMs + cacheMs;
  const dbId = hex(8);
  batch.span("api", {
    traceId,
    spanId: dbId,
    parentSpanId: apiId,
    name: `SELECT ${table}`,
    kind: KIND.client,
    startTimeUnixNano: ns(dbStart),
    endTimeUnixNano: ns(dbStart + dbMs),
    attributes: [
      str("db.system", "postgresql"),
      str("db.sql.table", table),
      str("db.statement", `SELECT * FROM ${table} WHERE id = $1`),
    ],
    events: failing
      ? [
          {
            timeUnixNano: ns(dbStart + dbMs),
            name: "exception",
            attributes: [
              str("exception.type", "QueryTimeout"),
              str("exception.message", `statement timeout after ${Math.round(dbMs)}ms`),
              str(
                "exception.stacktrace",
                `at db.query (db.ts:118)\n  at ${op} (api.ts:64)\n  at handler (server.ts:31)`,
              ),
            ],
          },
        ]
      : undefined,
    status: failing
      ? { code: STATUS.error, message: "statement timeout" }
      : { code: STATUS.ok },
  });

  batch.span("api", {
    traceId,
    spanId: apiId,
    parentSpanId: frontendId,
    name: op,
    kind: KIND.server,
    startTimeUnixNano: ns(nowMs),
    endTimeUnixNano: ns(nowMs + apiMs),
    attributes: [
      str("http.request.method", op.split(" ")[0]!),
      str("http.route", op.split(" ")[1]!),
      int("http.response.status_code", failing ? 503 : 200),
    ],
    events: [
      {
        timeUnixNano: ns(nowMs + cacheMs),
        name: "cache.hit",
        attributes: [str("cache.key", `session:${hex(4)}`)],
      },
    ],
    status: failing ? { code: STATUS.error, message: "upstream failure" } : { code: STATUS.ok },
  });

  batch.span("frontend", {
    traceId,
    spanId: frontendId,
    name: `GET ${route}`,
    kind: KIND.server,
    startTimeUnixNano: ns(nowMs),
    endTimeUnixNano: ns(nowMs + frontendMs),
    attributes: [
      str("http.request.method", "GET"),
      str("http.route", route),
      int("http.response.status_code", failing ? 503 : 200),
      str("client.address", `10.0.${Math.floor(Math.random() * 4)}.${Math.floor(Math.random() * 255)}`),
    ],
    events:
      route === "/checkout" && !failing
        ? [
            {
              timeUnixNano: ns(nowMs + frontendMs),
              name: "order.placed",
              attributes: [int("order.items", 1 + Math.floor(Math.random() * 4))],
            },
          ]
        : undefined,
    status: failing ? { code: STATUS.error } : { code: STATUS.ok },
  });

  // Correlated logs: the error path always logs, the happy path mostly stays quiet.
  const at = ns(nowMs + apiMs);
  if (failing) {
    const [n, text] = SEVERITY.error;
    batch.log("api", {
      timeUnixNano: at,
      severityNumber: n,
      severityText: text,
      body: { stringValue: `${op} failed: database statement timeout` },
      attributes: [str("http.route", route), str("error.kind", "QueryTimeout")],
      traceId,
      spanId: apiId,
    });
  } else if (dbMs > 35) {
    const [n, text] = SEVERITY.warn;
    batch.log("api", {
      timeUnixNano: at,
      severityNumber: n,
      severityText: text,
      body: { stringValue: `slow query on ${table}: ${Math.round(dbMs)}ms` },
      attributes: [str("db.sql.table", table)],
      traceId,
      spanId: dbId,
    });
  } else if (Math.random() < 0.2) {
    const [n, text] = SEVERITY.info;
    batch.log("frontend", {
      timeUnixNano: at,
      severityNumber: n,
      severityText: text,
      body: { stringValue: `served ${route} in ${Math.round(frontendMs)}ms` },
      attributes: [str("http.route", route)],
      traceId,
      spanId: frontendId,
    });
  }

  return { route, failing, durationMs: frontendMs };
}

// -- Metrics --

const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500];

class Metrics {
  private since = Date.now();
  private counts = new Map<string, number>(); // "route|outcome" -> requests
  private durations: number[] = [];

  record(route: string, failing: boolean, durationMs: number) {
    const key = `${route}|${failing ? "error" : "ok"}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.durations.push(durationMs);
  }

  /** Delta temporality: Uptrace stores deltas natively, so no conversion state. */
  drain(nowMs: number) {
    const startTimeUnixNano = ns(this.since);
    const timeUnixNano = ns(nowMs);
    const requests = [...this.counts].map(([key, count]) => {
      const [route, outcome] = key.split("|") as [string, string];
      return {
        asInt: String(count),
        startTimeUnixNano,
        timeUnixNano,
        attributes: [str("http.route", route), str("outcome", outcome)],
      };
    });

    const bucketCounts = Array<number>(BOUNDS.length + 1).fill(0);
    for (const d of this.durations) {
      const i = BOUNDS.findIndex((b) => d <= b);
      bucketCounts[i === -1 ? BOUNDS.length : i]! += 1;
    }
    const histogram = {
      count: String(this.durations.length),
      sum: this.durations.reduce((a, b) => a + b, 0),
      bucketCounts: bucketCounts.map(String),
      explicitBounds: BOUNDS,
      startTimeUnixNano,
      timeUnixNano,
      attributes: [] as KeyValue[],
    };

    this.since = nowMs;
    this.counts.clear();
    this.durations = [];
    if (requests.length === 0) return null;

    return {
      resourceMetrics: [
        {
          resource: resource("frontend"),
          scopeMetrics: [
            {
              scope: { name: "demo" },
              metrics: [
                {
                  name: "demo.requests",
                  unit: "1",
                  description: "Requests served, by route and outcome",
                  sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: requests },
                },
                {
                  name: "demo.request.duration",
                  unit: "ms",
                  description: "End-to-end request latency",
                  histogram: { aggregationTemporality: 1, dataPoints: [histogram] },
                },
              ],
            },
          ],
        },
      ],
    };
  }
}

// -- Shipping --

const dsn = `http://${TOKEN}@${new URL(ENDPOINT).host}/1`;
let failures = 0;

async function send(path: string, payload: unknown) {
  try {
    const res = await fetch(`${ENDPOINT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "uptrace-dsn": dsn },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      failures += 1;
      console.warn(`POST ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    failures += 1;
    console.warn(`POST ${path} failed: ${err instanceof Error ? err.message : err}`);
  }
}

// -- Main loop --

const batch = new Batch();
const metrics = new Metrics();
const startedAt = Date.now();
let served = 0;
let errored = 0;
let running = true;

/** Failure rate as a square wave: quiet, then an incident at the end of each cycle. */
function errorRate(nowMs: number): number {
  const phase = ((nowMs - startedAt) / 1000) % CYCLE_S;
  return phase >= CYCLE_S - INCIDENT_S ? INCIDENT_ERROR_RATE : BASE_ERROR_RATE;
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

console.log(
  `demo: ${RATE} req/s to ${ENDPOINT}, incident for ${INCIDENT_S}s every ${CYCLE_S}s ` +
    `(${BASE_ERROR_RATE * 100}% -> ${INCIDENT_ERROR_RATE * 100}% errors)`,
);

let lastMetrics = Date.now();
let lastReport = Date.now();

while (running) {
  const tickStart = Date.now();
  const rate = errorRate(tickStart);

  for (let i = 0; i < RATE; i++) {
    // Spread the tick's requests over the second so spans don't share a timestamp.
    const at = tickStart + (i * FLUSH_MS) / RATE;
    const r = simulateRequest(batch, at, Math.random() < rate);
    metrics.record(r.route, r.failing, r.durationMs);
    served += 1;
    if (r.failing) errored += 1;
  }

  const { spans, logs } = batch.drain();
  const posts: Promise<void>[] = [];
  if (spans.length > 0) {
    posts.push(
      send("/v1/traces", {
        resourceSpans: spans.map(([service, s]) => ({
          resource: resource(service),
          scopeSpans: [{ scope: { name: "demo" }, spans: s }],
        })),
      }),
    );
  }
  if (logs.length > 0) {
    posts.push(
      send("/v1/logs", {
        resourceLogs: logs.map(([service, l]) => ({
          resource: resource(service),
          scopeLogs: [{ scope: { name: "demo" }, logRecords: l }],
        })),
      }),
    );
  }
  if (tickStart - lastMetrics >= METRICS_EVERY_MS) {
    lastMetrics = tickStart;
    const payload = metrics.drain(tickStart);
    if (payload) posts.push(send("/v1/metrics", payload));
  }
  await Promise.all(posts);

  if (tickStart - lastReport >= 30_000) {
    lastReport = tickStart;
    console.log(
      `demo: ${served} requests, ${errored} errors, ${failures} failed posts, ` +
        `now at ${Math.round(rate * 100)}% error rate`,
    );
  }

  const elapsed = Date.now() - tickStart;
  if (elapsed < FLUSH_MS) await Bun.sleep(FLUSH_MS - elapsed);
}

console.log(`demo: stopping after ${served} requests`);
