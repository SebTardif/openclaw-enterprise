import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { seedAuthority, writer } from "../fixtures/runtime-authority-state/seed.mjs";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/errors.ts";

export const repositoryNamespace = () => ({
  id: `ns_${randomUUID()}`,
  name: `Repository ${randomUUID()}`,
  status: "ready",
  createdAt: new Date().toISOString(),
});

/** Run identical lifetime observations against each real adapter. */
export async function verifyRepositoryLifetime(t, store) {
  await t.test("read projections expose only reads and retained handles close", async () => {
    let escaped;
    await store.read(async (view) => {
      escaped = view;
      assert.equal(Object.hasOwn(view.installations, "createInstallation"), false);
      assert.equal(Object.hasOwn(view.namespaces, "lockNamespace"), false);
      assert.equal(Object.hasOwn(view.configurations, "deleteConfiguration"), false);
      assert.ok(await view.installations.getInstallation());
    });
    await assert.rejects(escaped.installations.getInstallation(), ScopeViolationError);
    await assert.rejects(escaped.namespaces.listNamespaces(), ScopeViolationError);
  });
  await t.test("accepted multi-step resource operations finish before publication", async () => {
    const namespace = repositoryNamespace();
    await store.transact((unit) => unit.namespaces.createNamespace(namespace));
    const configuration = {
      id: `cfg_${randomUUID()}`,
      namespaceId: namespace.id,
      kind: "agent",
      generation: 1,
      createdAt: namespace.createdAt,
    };
    let accepted;
    let completed = false;
    let escaped;
    await store.transact(async (unit) => {
      escaped = unit;
      // Creation awaits a Namespace lookup internally. The owner must drain the
      // whole admitted operation, including its later write, before publishing.
      accepted = unit.configurations.createConfiguration(configuration).then((created) => {
        completed = true;
        return created;
      });
    });
    assert.equal(completed, true);
    assert.deepEqual(await accepted, configuration);
    assert.deepEqual(
      await store.read((view) =>
        view.configurations.findConfiguration(namespace.id, configuration.id),
      ),
      configuration,
    );
    await assert.rejects(
      escaped.configurations.deleteConfiguration(namespace.id, configuration.id),
      ScopeViolationError,
    );
  });
  await verifyOwnerSettlement(t, store, "read", (view) => view.installations.getInstallation());
}

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

class CallbackPromise extends Promise {}
const promiseForms = [
  ["native", Promise],
  ["subclass", CallbackPromise],
  ["cross-realm", runInNewContext("Promise")],
];

function callbackPromise(Constructor, settled, rejected, failure) {
  let settle;
  const promise = new Constructor((resolve, reject) => {
    settle = () => (rejected ? reject(failure) : resolve("callback result"));
  });
  if (settled) settle();
  return { promise, settle };
}

/** Earlier reactions must see the original owner's boundary, including adapter projections. */
export async function verifyOwnerSettlement(t, store, method, effect) {
  for (const [form, Constructor] of promiseForms) {
    for (const settled of [false, true]) {
      for (const rejected of [false, true]) {
        await t.test(
          `${method} closes at ${settled ? "already-settled" : "pending"} ${form} ${rejected ? "rejection" : "fulfillment"}`,
          { timeout: 5000 },
          async () => {
            const ready = deferred();
            const failure = new Error("Original outer rejection");
            const namespace = repositoryNamespace();
            let sibling;
            let gate;
            let invoked = false;
            const transaction = store[method]((unit, queue) => {
              gate = callbackPromise(Constructor, settled, rejected, failure);
              const late = () =>
                effect(unit, queue, namespace, () => {
                  invoked = true;
                });
              // Attach before returning the actual user Promise to the owner.
              sibling = gate.promise.then(late, late);
              ready.resolve();
              return gate.promise;
            });
            const observed = rejected
              ? assert.rejects(transaction, (error) => error === failure)
              : transaction;
            await ready.promise;
            if (!settled) gate.settle();
            await assert.rejects(sibling, ScopeViolationError);
            await observed;
            assert.equal(invoked, false);
            assert.equal(
              await store.read((view) => view.namespaces.findNamespace(namespace.id)),
              undefined,
            );
          },
        );
      }
    }
  }
}

/**
 * Actual State/repository composition. The consume callback models the selected
 * IAM callback contract only; it does not implement entitlement or policy fences.
 */
export async function verifyAuthorityParticipants(t, store, foreignStore) {
  await verifyOwnerSettlement(t, store, "transact", (unit, _queue, namespace, invoked) =>
    store.runAuthorityParticipantIn(unit, () => {
      invoked();
      return unit.namespaces.createNamespace(namespace);
    }),
  );
  for (const [form, Constructor] of promiseForms) {
    for (const settled of [false, true]) {
      for (const rejected of [false, true]) {
        await t.test(
          `consume closes at ${settled ? "already-settled" : "pending"} ${form} ${rejected ? "rejection" : "fulfillment"}`,
          { timeout: 5000 },
          async () => {
            const namespace = repositoryNamespace();
            const failure = new Error("Original consume rejection");
            const transaction = store.transact(async (unit) => {
              const gate = callbackPromise(Constructor, settled, rejected, failure);
              let sibling;
              const participant = store.runAuthorityParticipantIn(unit, () => {
                const late = () => unit.namespaces.createNamespace(namespace);
                sibling = gate.promise.then(late, late);
                return gate.promise;
              });
              if (!settled) gate.settle();
              await assert.rejects(sibling, ScopeViolationError);
              if (rejected) await assert.rejects(participant, (error) => error === failure);
              else assert.equal(await participant, "callback result");
            });
            if (rejected) await assert.rejects(transaction, (error) => error === failure);
            else await transaction;
            assert.equal(
              await store.read((view) => view.namespaces.findNamespace(namespace.id)),
              undefined,
            );
          },
        );
      }
    }
  }
  await t.test(
    "whole consume invokes synchronously and accepts only the exact live UoW",
    async () => {
      let retained;
      let invoked = false;
      const value = Object.freeze({ consumed: true });
      await store.transact(async (unit) => {
        retained = unit;
        for (const candidate of [{ ...unit }, new Proxy(unit, {}), {}, null]) {
          await assert.rejects(
            store.runAuthorityParticipantIn(candidate, async () => {
              invoked = true;
            }),
            ScopeViolationError,
          );
        }
        await assert.rejects(
          foreignStore.runAuthorityParticipantIn(unit, async () => {
            invoked = true;
          }),
          ScopeViolationError,
        );
        assert.equal(invoked, false);
        const participant = store.runAuthorityParticipantIn(unit, async () => {
          invoked = true;
          return value;
        });
        assert.equal(invoked, true);
        assert.equal(await participant, value);
      });
      invoked = false;
      await assert.rejects(
        store.runAuthorityParticipantIn(retained, async () => {
          invoked = true;
        }),
        ScopeViolationError,
      );
      assert.equal(invoked, false);
    },
  );

  for (const kind of [
    "synchronous",
    "awaited",
    "unawaited",
    "nested caught conflict",
    "nested unawaited conflict",
  ]) {
    await t.test(kind + " authority failure rolls back ordinary repository changes", async () => {
      const namespace = repositoryNamespace();
      const failure = new Error("Original " + kind + " denial");
      let nestedError;
      await assert.rejects(
        store.transact(async (unit) => {
          await unit.namespaces.createNamespace(namespace);
          const consume = async () => {
            if (kind.startsWith("nested")) {
              const child = unit.runtimeAssignments.advanceRuntimeIntent(
                {},
                0,
                { desiredMode: "stopped" },
                randomUUID(),
                {},
              );
              if (kind === "nested caught conflict") {
                try {
                  await child;
                } catch (error) {
                  nestedError = error;
                }
              }
              return;
            }
            if (kind === "awaited") await Promise.resolve();
            throw failure;
          };
          const participant = store.runAuthorityParticipantIn(
            unit,
            kind === "synchronous"
              ? () => {
                  throw failure;
                }
              : consume,
          );
          if (kind !== "unawaited") {
            try {
              await participant;
            } catch {}
          }
        }),
        (error) =>
          kind.startsWith("nested")
            ? error instanceof ResourceConflictError &&
              (nestedError === undefined || error === nestedError)
            : error === failure,
      );
      assert.equal(
        await store.read((view) => view.namespaces.findNamespace(namespace.id)),
        undefined,
      );
    });
  }

  await t.test("ordinary caught conflicts remain nonsticky outside authority consume", async () => {
    const namespace = repositoryNamespace();
    await store.transact(async (unit) => {
      await assert.rejects(
        unit.runtimeAssignments.advanceRuntimeIntent(
          {},
          0,
          { desiredMode: "stopped" },
          randomUUID(),
          {},
        ),
        ResourceConflictError,
      );
      await unit.namespaces.createNamespace(namespace);
    });
    assert.equal(
      (await store.read((view) => view.namespaces.findNamespace(namespace.id))).id,
      namespace.id,
    );
  });

  await t.test(
    "accepted consume drains delayed reads and nested serial mutation before success",
    { timeout: 5000 },
    async () => {
      const f = await seedAuthority(store);
      const gate = deferred();
      const outerReturned = deferred();
      let retained;
      let completed = false;
      let participant;
      const result = Object.freeze({ original: true });
      const transaction = store.transact(async (unit) => {
        retained = unit;
        participant = store.runAuthorityParticipantIn(unit, async () => {
          await gate.promise;
          assert.ok(await unit.installations.getInstallation());
          const read = await unit.runtimeAuthority.findAssignment(
            f.target,
            f.allocation.assignmentRef,
          );
          assert.equal(read.authority.assignmentRecordVersion, 1);
          // This is the original production mutation binding and serial guard queue.
          assert.equal(
            (await unit.runtimeAuthority.appendMutation(f.bind, writer)).result,
            "applied",
          );
          completed = true;
        });
        outerReturned.resolve();
        return result;
      });
      await outerReturned.promise;
      await nextTurn();
      let lateInvoked = false;
      await assert.rejects(
        store.runAuthorityParticipantIn(retained, async () => {
          lateInvoked = true;
        }),
        ScopeViolationError,
      );
      await assert.rejects(retained.installations.getInstallation(), ScopeViolationError);
      assert.equal(lateInvoked, false);
      assert.equal(completed, false);
      gate.resolve();
      assert.equal(await transaction, result);
      await participant;
      assert.equal(completed, true);
      assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
    },
  );

  await t.test(
    "callback settlement revokes escaped siblings independently of accepted child work",
    { timeout: 5000 },
    async () => {
      const f = await seedAuthority(store);
      const escapeGate = deferred();
      let escaped;
      let invoked = false;
      let child;
      await store.transact(async (unit) => {
        await store.runAuthorityParticipantIn(unit, async () => {
          child = unit.runtimeAuthority.appendMutation(f.bind, writer);
          escaped = (async () => {
            await escapeGate.promise;
            await assert.rejects(
              unit.namespaces.createNamespace(repositoryNamespace()),
              ScopeViolationError,
            );
            await assert.rejects(
              store.runAuthorityParticipantIn(unit, async () => {
                invoked = true;
              }),
              ScopeViolationError,
            );
          })();
        });
        // Outer admission is still open. ALS presence must not revive the closed
        // callback; the accepted serial mutation retains its separate lifetime.
        escapeGate.resolve();
        await escaped;
        assert.equal(invoked, false);
      });
      assert.equal((await child).result, "applied");
      assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
    },
  );

  await t.test(
    "consume's own settlement closes admission before later wrapper continuations",
    { timeout: 5000 },
    async () => {
      const callbackGate = deferred();
      const escapeGate = deferred();
      let escaped;
      const namespace = repositoryNamespace();
      await store.transact(async (unit) => {
        const participant = store.runAuthorityParticipantIn(unit, () => {
          escaped = (async () => {
            await escapeGate.promise;
            await assert.rejects(unit.namespaces.createNamespace(namespace), ScopeViolationError);
          })();
          return callbackGate.promise;
        });
        // Queue both continuations in this order in one synchronous turn.
        // A guard-wrapper closure adds a hop and would admit the escaped sibling.
        callbackGate.resolve();
        escapeGate.resolve();
        await escaped;
        await participant;
      });
      assert.equal(
        await store.read((unit) => unit.namespaces.findNamespace(namespace.id)),
        undefined,
      );
    },
  );

  await t.test(
    "a sibling already awaiting the callback Promise cannot register at settlement",
    { timeout: 5000 },
    async () => {
      const callbackGate = deferred();
      const namespace = repositoryNamespace();
      let sibling;
      await store.transact(async (unit) => {
        const participant = store.runAuthorityParticipantIn(unit, () => {
          // This reaction is attached before the State owner sees the returned Promise.
          // Admission must close at settlement, before even the earlier reaction runs.
          sibling = (async () => {
            await callbackGate.promise;
            await assert.rejects(unit.namespaces.createNamespace(namespace), ScopeViolationError);
          })();
          return callbackGate.promise;
        });
        callbackGate.resolve();
        await sibling;
        await participant;
      });
      assert.equal(
        await store.read((unit) => unit.namespaces.findNamespace(namespace.id)),
        undefined,
      );
    },
  );

  await t.test(
    "new top-level consume cannot register from an accepted drain continuation",
    { timeout: 5000 },
    async () => {
      const gate = deferred();
      const outerReturned = deferred();
      let participant;
      let invoked = false;
      const transaction = store.transact(async (unit) => {
        participant = store.runAuthorityParticipantIn(unit, async () => {
          await gate.promise;
          await assert.rejects(
            store.runAuthorityParticipantIn(unit, async () => {
              invoked = true;
            }),
            ScopeViolationError,
          );
          assert.ok(await unit.installations.getInstallation());
        });
        outerReturned.resolve();
      });
      await outerReturned.promise;
      await nextTurn();
      gate.resolve();
      await transaction;
      await participant;
      assert.equal(invoked, false);
    },
  );

  await t.test(
    "two nonserial participants preserve original serial mutation order",
    { timeout: 5000 },
    async () => {
      const f = await seedAuthority(store);
      const gate = deferred();
      const outcomes = [];
      await store.transact(async (unit) => {
        const first = store.runAuthorityParticipantIn(unit, async () => {
          await gate.promise;
          outcomes.push((await unit.runtimeAuthority.appendMutation(f.bind, writer)).result);
        });
        const second = store.runAuthorityParticipantIn(unit, async () => {
          await gate.promise;
          outcomes.push(
            (
              await unit.runtimeAuthority.appendMutation(
                { ...f.bind, requestRef: "second-participant" },
                writer,
              )
            ).result,
          );
        });
        gate.resolve();
        await Promise.all([first, second]);
      });
      assert.deepEqual(outcomes, ["applied", "exact-replay"]);
      assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
    },
  );

  await t.test(
    "one failed participant shares sticky failure and drains its accepted sibling",
    { timeout: 5000 },
    async () => {
      const namespace = repositoryNamespace();
      const gate = deferred();
      const outerReturned = deferred();
      const failure = new Error("First participant denial");
      let completed = false;
      const transaction = store.transact(async (unit) => {
        store.runAuthorityParticipantIn(unit, async () => {
          await gate.promise;
          assert.ok(await unit.installations.getInstallation());
          await unit.namespaces.createNamespace(namespace);
          completed = true;
        });
        try {
          await store.runAuthorityParticipantIn(unit, () => {
            throw failure;
          });
        } catch {}
        outerReturned.resolve();
      });
      const observed = assert.rejects(transaction, (error) => error === failure);
      await outerReturned.promise;
      await nextTurn();
      assert.equal(completed, false);
      gate.resolve();
      await observed;
      assert.equal(completed, true);
      assert.equal(
        await store.read((view) => view.namespaces.findNamespace(namespace.id)),
        undefined,
      );
    },
  );

  await t.test(
    "outer rollback also drains accepted consume before releasing its transaction",
    { timeout: 5000 },
    async () => {
      const f = await seedAuthority(store);
      const gate = deferred();
      const outerReturned = deferred();
      const failure = new Error("Original outer failure");
      let completed = false;
      const transaction = store.transact(async (unit) => {
        store.runAuthorityParticipantIn(unit, async () => {
          await gate.promise;
          assert.ok(await unit.installations.getInstallation());
          await unit.runtimeAuthority.appendMutation(f.bind, writer);
          completed = true;
        });
        outerReturned.resolve();
        throw failure;
      });
      const observed = assert.rejects(transaction, (error) => error === failure);
      await outerReturned.promise;
      await nextTurn();
      assert.equal(completed, false);
      gate.resolve();
      await observed;
      assert.equal(completed, true);
      assert.equal((await f.record()).authority.assignmentRecordVersion, 1);
      assert.equal(await f.operation(f.bind.operationRef), undefined);
    },
  );
}
