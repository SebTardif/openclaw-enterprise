import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { installObservabilityDemo } from "../helpers/observability-demo-k3d.mjs";

test(
  "demo Helm stack ingests fixture metrics and OTLP logs through Grafana",
  {
    skip:
      process.env.OCC_TEST_OBSERVABILITY_DEMO === "1"
        ? false
        : "Run pnpm test:observability --demo.",
    timeout: 600_000,
  },
  async (t) => {
    const demo = await installObservabilityDemo(t);
    const expression = 'demo_smoke_value{job=~"occ-api|occ-worker|collector"}';
    await demo.waitFor("all fixture metrics through Grafana's Prometheus connection", async () => {
      const rows = await demo.query(
        "prometheus",
        `/api/v1/query?query=${encodeURIComponent(expression)}`,
      );
      return (
        new Set(
          rows.filter(({ value }) => Number(value[1]) === 1).map(({ metric }) => metric.source),
        ).size === 3
      );
    });
    const marker = `demo-smoke-${randomUUID()}`;
    await demo.exportLog(marker);
    await demo.waitFor("OTLP log through Grafana's Loki connection", async () => {
      const expression = `{service_name="demo-smoke"} |= "${marker}"`;
      const rows = await demo.query(
        "loki",
        `/loki/api/v1/query_range?query=${encodeURIComponent(expression)}&since=5m`,
      );
      return rows.some(({ values }) => values.some(([, line]) => line === marker));
    });
    for (const uid of ["occ-development", "occ-logs"]) {
      const response = await demo.grafana(`/api/dashboards/uid/${uid}`);
      assert.equal(response.status, 200);
      assert.ok(JSON.parse(response.text).dashboard.panels.length > 0);
    }

    // These are post-Collector OTLP fixtures. Prove the chart's real metadata
    // presentation and queries, not producer sanitization or Agent lifecycle.
    const requestId = randomUUID();
    const records = [
      {
        event: "http.completed",
        service: "occ-api",
        attributes: {
          "http.request.method": "GET",
          "http.response.status_code": 200,
          duration_ms: 8.042,
          "request.id": requestId,
        },
        line: "occ-api | http.completed GET status=200 duration=8.042ms",
      },
      ...[401, 500].map((status) => ({
        event: "http.completed",
        service: "occ-api",
        attributes: {
          "http.request.method": "POST",
          "http.response.status_code": status,
          duration_ms: 0,
        },
        line: `occ-api | http.completed POST status=${status} duration=0ms`,
        attention: true,
      })),
      { event: "listening", service: "occ-api", line: "occ-api | listening" },
      ...[
        ["success", "NAMESPACE_READY"],
        ["pending", "NAMESPACE_PENDING"],
        ["retry", "DEPENDENCY_UNAVAILABLE"],
        ["permanent", "ACTOR_REVOKED"],
        ["failure", "UNEXPECTED_ERROR"],
      ].map(([outcome, code]) => ({
        event: "worker.completed",
        service: "occ-worker",
        attributes: {
          "work.operation": "namespace.ensure",
          "work.outcome": outcome,
          "work.attempt": 1,
          "occ.code": code,
        },
        line: `occ-worker | worker.completed operation=namespace.ensure outcome=${outcome} attempt=1 code=${code}`,
        attention: ["retry", "permanent", "failure"].includes(outcome),
      })),
      { event: "worker.health", service: "occ-worker", line: "occ-worker | worker.health" },
      {
        event: "gateway.operational",
        service: "openclaw-gateway",
        severity: "WARN",
        line: "openclaw-gateway | gateway.operational",
        attention: true,
      },
      {
        event: "codex.operational",
        service: "codex-app-server",
        severity: "ERROR",
        line: "codex-app-server | codex.operational",
        attention: true,
      },
    ];
    for (const { event, service, severity, attributes } of records) {
      await demo.exportLog(event, {
        service,
        severity,
        attributes: { "event.name": event, ...attributes },
      });
    }
    const health = await demo.grafana("/api/health");
    assert.equal(JSON.parse(health.text).version, "13.2.2");
    const { page, url } = await demo.openBrowser();
    const queries = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/ds/query") {
        for (const query of request.postDataJSON()?.queries ?? []) {
          if (query.datasource?.uid === "occ-loki" && query.expr?.includes("line_format")) {
            queries.push(query.expr);
          }
        }
      }
    });
    await page.goto(`${url}/d/occ-logs?from=now-5m&to=now&refresh=1h`, {
      waitUntil: "domcontentloaded",
    });
    const allPanel = page.getByLabel("All events panel", { exact: true });
    const attentionPanel = page.getByLabel("Needs attention panel", { exact: true });
    await allPanel.getByText(records[0].line, { exact: true }).waitFor();
    await attentionPanel.getByText(records[2].line, { exact: true }).waitFor();

    // Capture Grafana's actual interpolated panel expressions. Re-query them
    // through its datasource: no test-owned copy of LogQL or variable escaping.
    const assertQueries = async (expected) => {
      await demo.waitFor("both rendered panel queries", () => new Set(queries).size === 2);
      for (const expression of new Set(queries)) {
        const attention = expression.includes("severity_text");
        const lines = expected
          .filter((record) => !attention || record.attention)
          .map(({ line }) => line)
          .sort();
        await demo.waitFor("exact dashboard query results", async () => {
          const rows = await demo.query(
            "loki",
            `/loki/api/v1/query_range?query=${encodeURIComponent(expression)}&since=5m`,
          );
          const actual = rows.flatMap(({ values }) => values.map(([, line]) => line)).sort();
          return JSON.stringify(actual) === JSON.stringify(lines);
        });
      }
    };
    await assertQueries(records);
    await page.screenshot({ path: join(demo.artifacts, "logs-all-events.png"), fullPage: true });

    // Formatting changes only the query result. The original event and request
    // correlation remain available for native metadata filtering/drill-down.
    const correlated = await demo.query(
      "loki",
      `/loki/api/v1/query_range?query=${encodeURIComponent(`{service_name="occ-api"} | request_id="${requestId}"`)}&since=5m`,
    );
    assert.deepEqual(
      correlated.flatMap(({ values }) => values.map(([, line]) => line)),
      ["http.completed"],
    );
    await allPanel.getByText(records[0].line, { exact: true }).click();
    await allPanel.getByText(requestId, { exact: true }).waitFor();
    await page.screenshot({ path: join(demo.artifacts, "logs-details.png"), fullPage: true });

    queries.length = 0;
    await page
      .getByTestId(
        "data-testid Dashboard template variables Variable Value DropDown value link text All",
      )
      .first()
      .click();
    await page
      .getByTestId(
        "data-testid Dashboard template variables Variable Value DropDown option text occ-worker",
      )
      .click();
    await allPanel.getByText(records[0].line, { exact: true }).waitFor({ state: "hidden" });
    await assertQueries(records.filter(({ service }) => service === "occ-worker"));

    queries.length = 0;
    await page
      .getByTestId(
        "data-testid Dashboard template variables Variable Value DropDown value link text All",
      )
      .click();
    await page
      .getByTestId(
        "data-testid Dashboard template variables Variable Value DropDown option text worker.completed",
      )
      .click();
    await assertQueries(records.filter(({ event }) => event === "worker.completed"));
    await attentionPanel.getByText(records[6].line, { exact: true }).waitFor();
    await page.screenshot({ path: join(demo.artifacts, "logs-worker-filter.png"), fullPage: true });
  },
);
