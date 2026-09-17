import assert from "node:assert/strict";
import test from "node:test";
import { getServers } from "node:dns";
import { performance } from "node:perf_hooks";
import {
  bothFamilies,
  bounds,
  delay,
  expectSelection,
  nativeDns,
  nativeSelector,
  public4,
  public6,
  publicAnswers,
  refused,
} from "../helpers/credential-gateway-dns.mjs";

const answerCases = [
  {
    name: "A plus AAAA selects frozen first A at port 443",
    answers: { A: [public4, "140.82.113.3"], AAAA: [public6, "2606:50c0:8001::153"] },
  },
  {
    name: "configured IPv6 loopback server and nondefault port",
    server: "::1",
    answers: publicAnswers,
    expected: { hostname: "api.github.com" },
  },
  {
    name: "NOERROR empty opposite family selects A",
    answers: { A: [public4], AAAA: [] },
  },
  {
    name: "NOERROR empty opposite family selects first AAAA",
    answers: { A: [], AAAA: [public6, "2606:50c0:8001::153"] },
    expected: { address: public6, family: 6 },
  },
  {
    name: "both native ENODATA families refuse empty-answer",
    answers: { A: [], AAAA: [] },
    expected: { error: "empty-answer" },
  },
  {
    name: "safe first and later private A refuse complete set",
    answers: { A: [public4, "10.0.0.1"], AAAA: [public6] },
    expected: { error: "address-denied" },
  },
  {
    name: "safe first and later private AAAA refuse complete set",
    answers: { A: [public4], AAAA: [public6, "fc00::1"] },
    expected: { error: "address-denied" },
  },
  {
    name: "NXDOMAIN in A refuses despite safe opposite family",
    answers: { A: { rcode: 3 }, AAAA: [public6] },
    expected: { error: "dns-failure" },
  },
  {
    name: "NXDOMAIN in AAAA refuses despite safe opposite family",
    answers: { A: [public4], AAAA: { rcode: 3 } },
    expected: { error: "dns-failure" },
  },
];

test(
  "configured native DNS component: real loopback wire and cleanup",
  { timeout: 10000 },
  async (t) => {
    const globalServers = getServers();
    t.after(() =>
      assert.deepEqual(getServers(), globalServers, "global DNS configuration unchanged"),
    );
    for (const { name, answers, server, expected } of answerCases) {
      await t.test(name, async (t) => {
        await expectSelection(await nativeDns(t, answers, server), expected);
      });
    }

    await t.test("multiple configured servers preserve native first-server order", async (t) => {
      const first = await nativeDns(t, publicAnswers);
      const second = await nativeDns(t, { silent: true });
      const selector = nativeSelector({
        ...first.config,
        servers: [...first.config.servers, ...second.config.servers],
      });
      await expectSelection(first, { selector });
      assert.deepEqual(second.queries, [], "no application query to the unused server");
      assert.equal(second.sent, 0);
    });

    await t.test("silent configured server settles at selector deadline", async (t) => {
      const f = await nativeDns(t, { silent: true });
      // The selector deadline precedes the native timeout, isolating terminal cancellation.
      const started = performance.now();
      const selected = f.selector.select("github.com", bounds(undefined, 80));
      await assert.rejects(selected, refused("deadline"));
      assert.ok(performance.now() - started < 500, "settled before native timeout");
      bothFamilies(f.queries);
      assert.equal(f.sent, 0);
    });

    await t.test("fresh selections send fresh A/AAAA and observe changed answers", async (t) => {
      let answer = public4;
      const f = await nativeDns(t, () => ({ A: [answer], AAAA: [] }));
      assert.equal((await f.selector.select("github.com", bounds())).address, public4);
      answer = "140.82.113.3";
      assert.equal((await f.selector.select("github.com", bounds())).address, answer);
      assert.equal(f.queries.length, 4);
      bothFamilies(f.queries.slice(0, 2));
      bothFamilies(f.queries.slice(2));
      assert.equal(f.sent, 4);
    });

    await t.test(
      "concurrent cancellation is isolated and late real responses cannot succeed",
      async (t) => {
        const f = await nativeDns(t, ({ name }) => ({
          ...publicAnswers,
          delayMs: name === "github.com" ? 100 : 40,
        }));
        const controller = new AbortController();
        const aborted = f.selector.select("github.com", bounds(controller.signal));
        const denial = assert.rejects(aborted, refused("aborted"));
        const independent = f.selector.select("api.github.com", bounds());
        // Abort after both calls have real A and AAAA queries in flight.
        await f.waitQueries(4);
        controller.abort();
        await denial;
        assert.equal((await independent).address, public4);
        await delay(120);
        bothFamilies(f.queries.filter(({ name }) => name === "github.com"));
        bothFamilies(
          f.queries.filter(({ name }) => name === "api.github.com"),
          "api.github.com",
        );
        assert.equal(f.sent, 4, "actual late responses emitted after cancellation");
      },
    );
  },
);
