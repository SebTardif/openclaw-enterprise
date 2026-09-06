import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkScenarioPacket,
  parseScenarioJson,
  REQUIRED_CASE_IDS,
  LIMITS,
} from "../fixtures/shared-native-scenarios-v1/checker.ts";

const directory = new URL("../fixtures/shared-native-scenarios-v1/", import.meta.url);
const original = Object.fromEntries(
  ["manifest", "cases", "traces"].map((name) => [
    name,
    JSON.parse(readFileSync(new URL(`${name}.json`, directory), "utf8")),
  ]),
);
const run = (packet = original) =>
  checkScenarioPacket(
    ...["manifest", "cases", "traces"].map((name) => JSON.stringify(packet[name])),
  );
const altered = (change) => {
  const packet = structuredClone(original);
  change(packet);
  return run(packet);
};
const first = (p, kind, turnId = "turn-1", caseIndex = 0) =>
  p.traces.cases[caseIndex].observations.find((v) => v.kind === kind && v.turnId === turnId);
const has = (report, code) =>
  assert.ok(
    report.findings.some((f) => f.code === code),
    JSON.stringify(report),
  );
const resequence = (rows) =>
  rows.forEach((row, i) => {
    row.sequence = i + 1;
  });

test("all twenty labeled scenarios are supplied and internally consistent without runtime qualification", () => {
  const report = run();
  assert.deepEqual(report, {
    evidenceKind: "synthetic-dispatched-committed-trace",
    runtimeQualified: false,
    evidenceAuthenticated: false,
    expected: 20,
    discovered: 20,
    supplied: 20,
    consistent: 20,
    inconsistent: 0,
    incomplete: 0,
    unrun: 0,
    findings: [],
    findingsTruncated: false,
  });
  assert.equal(new Set(REQUIRED_CASE_IDS).size, 20);
  for (const platform of ["slack", "msteams"])
    assert.equal(
      original.cases.cases.filter(
        (c) => c.id.startsWith(platform + "/") && !c.id.includes("logical-twin"),
      ).length,
      8,
    );
});

test("missing native trace remains unrun in the fixed denominator", () => {
  const report = altered((p) => p.traces.cases.pop());
  assert.equal(report.expected, 20);
  assert.equal(report.consistent, 19);
  assert.equal(report.unrun, 1);
  has(report, "missing-trace-case");
});

test("duplicate and foreign case identities cannot inflate supplied coverage", () => {
  const duplicate = altered((p) => p.traces.cases.push(structuredClone(p.traces.cases[0])));
  has(duplicate, "duplicate-trace-case");
  assert.equal(duplicate.supplied, 20);
  assert.equal(duplicate.inconsistent, 1);
  const foreign = altered((p) => {
    p.traces.cases[0].caseId = "unselected";
  });
  has(foreign, "foreign-trace-case");
  assert.equal(foreign.unrun, 1);
  assert.equal(foreign.consistent, 0);
});

test("removed or changed case definitions cannot redefine the required corpus", () => {
  has(
    altered((p) => p.cases.cases.pop()),
    "missing-case-definition",
  );
  has(
    altered((p) => {
      p.cases.cases[2].turns[1].disposition = "conflict";
    }),
    "scenario-second-disposition",
  );
  has(
    altered((p) => {
      p.cases.cases[0].turns[1].actorRef = "actor-A";
    }),
    "scenario-distinct-humans",
  );
});

test("every accepted turn requires prior admission and dispatch", () => {
  for (const kind of ["admission", "dispatch"]) {
    const report = altered((p) => {
      const rows = p.traces.cases[0].observations;
      rows.splice(
        rows.findIndex((r) => r.kind === kind),
        1,
      );
    });
    has(report, `missing-${kind}`);
    has(
      report,
      kind === "admission" ? "missing-prior-admission" : "effect-outside-dispatched-interval",
    );
  }
});

test("a context event moved before dispatch is an ordering failure even with monotonic labels", () => {
  has(
    altered((p) => {
      const rows = p.traces.cases[0].observations;
      [rows[1], rows[2]] = [rows[2], rows[1]];
      resequence(rows);
    }),
    "effect-outside-dispatched-interval",
  );
});

test("simultaneous accepted workspace mutators are rejected across both platform scopes", () => {
  for (const index of [0, 1, 8, 9]) {
    has(
      altered((p) => {
        const rows = p.traces.cases[index].observations;
        const second = rows.filter(
          (r) => r.turnId === "turn-2" && ["admission", "dispatch"].includes(r.kind),
        );
        p.traces.cases[index].observations = [
          ...rows.slice(0, 2),
          ...second,
          ...rows.slice(2).filter((r) => !second.includes(r)),
        ];
        resequence(p.traces.cases[index].observations);
      }),
      "concurrent-workspace-writers",
    );
  }
});

test("busy and duplicate payloads cannot enter a model, tool, context or output", () => {
  for (const caseIndex of [2, 4, 5, 10, 12, 13, 16, 18])
    for (const kind of ["context", "model", "tool", "output"]) {
      has(
        altered((p) => {
          const row = structuredClone(first(p, kind, "turn-1", caseIndex));
          row.turnId = "turn-2";
          row.binding = null;
          p.traces.cases[caseIndex].observations.splice(3, 0, row);
          resequence(p.traces.cases[caseIndex].observations);
        }),
        "suppressed-turn-effect",
      );
    }
});

test("suppressed, foreign-thread and foreign-platform context payloads are rejected", () => {
  for (const index of [1, 2, 9, 16])
    has(
      altered((p) => {
        first(p, "context", "turn-1", index).detail.payloadRefs.push("payload-2");
      }),
      "suppressed-or-foreign-context",
    );
  has(
    altered((p) => {
      first(p, "context", "turn-2", 1).detail.payloadRefs.unshift("payload-1");
    }),
    "suppressed-or-foreign-context",
  );
  has(
    altered((p) => {
      first(p, "context", "turn-3", 16).detail.payloadRefs.unshift("payload-1");
    }),
    "suppressed-or-foreign-context",
  );
});

test("same-thread follow-up retains its scoped observed context", () => {
  has(
    altered((p) => {
      first(p, "context", "turn-2").detail.payloadRefs = ["payload-2"];
    }),
    "context-history-omission-or-order",
  );
});

test("sticky busy retry keeps the original busy owner after the observed writer ends", () => {
  has(
    altered((p) => {
      p.cases.cases[4].turns[2].ownerTurnId = "turn-1";
    }),
    "sticky-busy-owner",
  );
  has(
    altered((p) => {
      const rows = p.traces.cases[4].observations;
      rows.splice(3, 0, rows.pop());
      resequence(rows);
    }),
    "retry-or-follow-up-before-idle",
  );
  has(
    altered((p) => {
      first(p, "admission", "turn-3", 4).detail.disposition = "accepted";
    }),
    "admission-label-substitution",
  );
});

test("both logical twin orders retain one owner and changed payload stays conflict", () => {
  for (const index of [18, 19])
    has(
      altered((p) => {
        p.cases.cases[index].turns[1].ownerTurnId = "another-owner";
      }),
      "scenario-owner-label",
    );
  for (const index of [6, 14])
    has(
      altered((p) => {
        p.cases.cases[index].turns[1].payloadRef = "payload-1";
      }),
      "scenario-replay-relationship",
    );
});

for (const key of Object.keys(original.cases.cases[0].turns[0].binding))
  test(`exact binding rejects a substituted ${key}`, () => {
    has(
      altered((p) => {
        const b = first(p, "model").binding;
        b[key] = typeof b[key] === "number" ? b[key] + 1 : "foreign";
      }),
      "binding-substitution",
    );
  });

test("output remains bound to original platform, thread and reply destination", () => {
  for (const [key, value] of [
    ["platform", "msteams"],
    ["threadRef", "other-thread"],
    ["replyBindingRef", "other-reply"],
    ["replyBindingVersion", 2],
  ]) {
    has(
      altered((p) => {
        first(p, "output").detail[key] = value;
      }),
      "output-redirection",
    );
  }
});

test("unknown delivery cannot become confirmed creation or a second output attempt", () => {
  has(
    altered((p) => {
      const d = first(p, "output", "turn-1", 7).detail;
      d.outcome = "delivered";
      d.providerMessageRef = "invented";
    }),
    "unknown-output-promoted",
  );
  has(
    altered((p) => {
      const rows = p.traces.cases[7].observations;
      const row = structuredClone(first(p, "output", "turn-1", 7));
      row.detail.deliveryAttemptRef = "retry";
      rows.splice(6, 0, row);
      resequence(rows);
    }),
    "output-replay-without-proof",
  );
});

test("native completion never supplies an absent OCC checkpoint", () => {
  const report = altered((p) => {
    p.traces.cases[0].observations = p.traces.cases[0].observations.filter(
      (r) => r.kind !== "occ-checkpoint",
    );
  });
  has(report, "missing-occ-checkpoint");
  assert.equal(report.incomplete, 1);
  assert.equal(report.consistent, 19);
  has(
    altered((p) => {
      first(p, "native-completion").detail.checkpoint = "verified";
    }),
    "invalid-observation",
  );
  has(
    altered((p) => {
      first(p, "occ-checkpoint").detail.origin = "native-completion";
    }),
    "invalid-observation",
  );
  has(
    altered((p) => {
      first(p, "occ-checkpoint").detail.completionSequence++;
    }),
    "checkpoint-sequence-substitution",
  );
});

test("missing context, work, output and writer end remain incomplete", () => {
  for (const kind of ["context", "model", "tool", "output", "native-completion", "writer-end"])
    has(
      altered((p) => {
        p.traces.cases[0].observations = p.traces.cases[0].observations.filter(
          (r) => r.kind !== kind,
        );
      }),
      `missing-${kind}`,
    );
});

test("closed shapes, original SDK pins and monotonic sequence are enforced", () => {
  has(
    altered((p) => {
      p.manifest.selectedSdk.sourceCommit = "a".repeat(40);
    }),
    "manifest-identity-or-shape",
  );
  has(
    altered((p) => {
      p.manifest.runtimeQualified = true;
    }),
    "manifest-identity-or-shape",
  );
  has(
    altered((p) => {
      first(p, "model").secret = "never echoed";
    }),
    "invalid-observation",
  );
  has(
    altered((p) => {
      first(p, "model").sequence = 1;
    }),
    "nonmonotonic-sequence",
  );
});

test("bounded JSON rejects duplicate keys, fractional and unsafe counters, depth and Unicode", () => {
  for (const input of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"a":1.0}',
    '{"a":1e0}',
    '{"a":9007199254740993}',
    '"\\ud800"',
    "[".repeat(18) + "0" + "]".repeat(18),
    "null false",
  ])
    assert.throws(() => parseScenarioJson(input));
  assert.throws(() => parseScenarioJson('"' + "x".repeat(LIMITS.packetBytes) + '"'));
  assert.equal(parseScenarioJson('"😀"'), "😀");
  assert.deepEqual(Object.keys(parseScenarioJson('{"__proto__":1}')), ["__proto__"]);
  has(checkScenarioPacket("{}", "[]", "[]"), "invalid-case-catalog");
});

test("case, observation, reference, finding and aggregate packet bounds fail explicitly", () => {
  has(
    altered((p) => {
      p.traces.cases = Array.from({ length: 33 }, () => p.traces.cases[0]);
    }),
    "invalid-trace-catalog",
  );
  has(
    altered((p) => {
      p.traces.cases[0].observations = Array.from({ length: 65 }, () => first(p, "model"));
    }),
    "invalid-trace-shape",
  );
  has(
    altered((p) => {
      first(p, "model").detail.payloadRef = "😀".repeat(65);
    }),
    "invalid-observation",
  );
  const report = altered((p) => {
    for (const row of p.traces.cases)
      for (const event of row.observations) {
        event.binding = null;
        event.sequence = 1;
      }
  });
  assert.equal(report.findings.length, 256);
  assert.equal(report.findingsTruncated, true);
  assert.equal(report.consistent, 0);
  has(checkScenarioPacket(" ".repeat(LIMITS.packetBytes), "{}", "{}"), "invalid-json-or-bound");
});

test("findings never echo submitted payload or supplied command fields", () => {
  const secret = "synthetic-secret-canary";
  const report = altered((p) => {
    first(p, "model").detail = { argv: [secret], text: secret };
  });
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("the public-data projection preserves source observations and never manufactures checkpoint or termination", async () => {
  const { observePublicTurn } = await import("../fixtures/shared-native-scenarios-v1/consumer.ts");
  const attempt = { schemaVersion: 1, ...original.cases.cases[0].turns[0].binding };
  const envelope = {
    platform: "slack",
    adapterProfileRef: "slack-private-mentioned-v1",
    installationRef: "installation-A",
    channelInstallationRef: "channel-installation-A",
    providerTenantRef: "tenant-A",
    recipientAppRef: "recipient-A",
    sender: { kind: "human", providerSubjectRef: "external-human-A" },
    event: {
      providerEventRef: "provider-event",
      eventKind: "message",
      eventDigest: "a".repeat(64),
      occurredAt: "2026-09-06T01:02:03.000001Z",
    },
    message: { logicalMessageKey: "b".repeat(64), contentDigest: "c".repeat(64) },
    nativeConversation: { channelRef: "channel-A", rootThreadRef: "root-A" },
    receivedAt: "2026-09-06T01:02:03.000002Z",
    verifiedAt: "2026-09-06T01:02:03.000003Z",
    text: "omitted-payload-canary",
  };
  const native = {
    nativeSessionRef: "native-session",
    nativeTurnRef: "native-turn",
    sequence: 1,
    event: "execution-completed",
  };
  const output = {
    receiptRef: "separate-output-receipt",
    turnRef: "separate-output-turn",
    conversationRef: "separate-output-conversation",
    replyDestinationRef: "reply-A",
    replyBindingVersion: 1,
    deliveryAttemptRef: "delivery-A",
    slot: "completed-result",
    operation: "create",
    text: "omitted-output-canary",
  };
  const harness = {
    requestRef: "request-A",
    conversationRef: "conversation-A",
    attemptRef: "attempt-A",
    assignmentRef: "assignment-A",
    runtimeGeneration: 1,
    state: "completed",
    cancellation: "requested",
    checkpoint: "unverified",
  };
  const observation = observePublicTurn(envelope, attempt, native, output, harness);
  assert.equal(observation.occCheckpoint, null);
  assert.equal(observation.physicalWriterTermination, "unmeasured");
  assert.equal(observation.runtimeQualified, false);
  assert.equal(observation.evidenceAuthenticated, false);
  assert.deepEqual(observation.binding, original.cases.cases[0].turns[0].binding);
  assert.equal(observation.envelope.occurredAt, envelope.event.occurredAt);
  assert.equal(observation.envelope.receivedAt, envelope.receivedAt);
  assert.equal(observation.envelope.verifiedAt, envelope.verifiedAt);
  assert.equal(observation.output.receiptRef, output.receiptRef);
  assert.equal(observation.output.replyDestinationRef, "reply-A");
  assert.equal(observation.harness.cancellation, "requested");
  assert.equal(observation.harness.checkpoint, "unverified");
  assert.equal(JSON.stringify(observation).includes("canary"), false);
  attempt.principalRef = "changed";
  native.event = "execution-unknown";
  assert.equal(observation.binding.principalRef, "actor-A");
  assert.equal(observation.nativeEvent.event, "execution-completed");
});

test("cross-platform follow-up retains the second human and thread with genuinely fresh inputs", () => {
  for (const caseIndex of [16, 17]) {
    for (const [field, value] of [
      ["actorRef", "third-human"],
      ["threadRef", "third-thread"],
      ["eventRef", "event-1"],
      ["eventRef", "event-2"],
      ["logicalMessageRef", "logical-1"],
      ["logicalMessageRef", "logical-2"],
      ["payloadRef", "payload-1"],
      ["payloadRef", "payload-2"],
    ]) {
      has(
        altered((p) => {
          const turn = p.cases.cases[caseIndex].turns[2];
          turn[field] = value;
          if (field === "actorRef") {
            turn.binding.principalRef = value;
            for (const event of p.traces.cases[caseIndex].observations)
              if (event.turnId === turn.id) event.binding.principalRef = value;
          }
        }),
        "cross-platform-sequence",
      );
    }
  }
});

test("sticky retry retains the original busy input event kind", () => {
  for (const index of [4, 12])
    has(
      altered((p) => {
        p.cases.cases[index].turns[2].eventKind = "app_mention";
      }),
      "sticky-busy-owner",
    );
});

for (const [field, code] of [
  ["receiptRef", "reused-accepted-receipt"],
  ["turnRef", "reused-accepted-turn"],
])
  test(`distinct accepted turns cannot alias ${field} even when every trace binding agrees`, () => {
    has(
      altered((p) => {
        const [firstTurn, secondTurn] = p.cases.cases[0].turns;
        secondTurn.binding[field] = firstTurn.binding[field];
        for (const event of p.traces.cases[0].observations)
          if (event.turnId === secondTurn.id) event.binding[field] = firstTurn.binding[field];
      }),
      code,
    );
  });

test("mentioned-text is an explicit supplied path label, never inferred from a successful trace", () => {
  for (const replacement of [
    undefined,
    "active-steer",
    "collect",
    "direct-session",
    "bare-handler",
  ])
    has(
      altered((p) => {
        if (replacement === undefined) delete p.cases.cases[0].turns[0].inputPath;
        else p.cases.cases[0].turns[0].inputPath = replacement;
      }),
      "invalid-case-shape",
    );
});
