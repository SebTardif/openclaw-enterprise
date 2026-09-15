import assert from "node:assert/strict";
import {
  createDestinationSelector,
  DestinationError,
} from "../../apps/credential-gateway/src/transport/destination.ts";

export const destinationConfig = (overrides = {}) => ({
  servers: [{ address: "127.0.0.1", port: 5353 }],
  lookupTimeoutMs: 1000,
  ...overrides,
});
export const selectionBounds = (overrides = {}) => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 2000,
  ...overrides,
});
export const destinationError = (code) => (error) => {
  assert.ok(error instanceof DestinationError);
  assert.equal(error.code, code);
  assert.equal(error.message, `Destination selection refused: ${code}`);
  return true;
};
export const dnsFailure = (code) => () =>
  Promise.reject(Object.assign(new Error("external DNS detail"), { code }));

export function deferred() {
  return Promise.withResolvers();
}

// The resolver is the supported dependency boundary. It supplies answers and records
// effects; address policy, cancellation and selection always run in the real selector.
export function destinationHarness({
  v4 = ["140.82.112.3"],
  v6 = [],
  config = destinationConfig(),
  onCreate = () => {},
  onCancel = () => {},
} = {}) {
  const observations = [];
  const selector = createDestinationSelector(config, (retained) => {
    const observation = { retained, queries: [], cancellations: 0 };
    const id = observations.length;
    observations.push(observation);
    onCreate(id);
    return {
      resolve4(hostname) {
        observation.queries.push([4, hostname]);
        return typeof v4 === "function" ? v4(id) : Promise.resolve(v4);
      },
      resolve6(hostname) {
        observation.queries.push([6, hostname]);
        return typeof v6 === "function" ? v6(id) : Promise.resolve(v6);
      },
      cancel() {
        observation.cancellations++;
        onCancel(id);
      },
    };
  });
  const select = (hostname = "github.com", bounds = selectionBounds()) =>
    selector.select(hostname, bounds);
  return {
    observations,
    select,
    refuses(code, { hostname = "github.com", bounds = selectionBounds() } = {}) {
      return assert.rejects(select(hostname, bounds), destinationError(code));
    },
    assertCancellations(...counts) {
      assert.deepEqual(
        observations.map(({ cancellations }) => cancellations),
        counts,
      );
    },
  };
}

export async function assertAddress(address, family, permitted) {
  const harness = destinationHarness(family === 4 ? { v4: [address] } : { v4: [], v6: [address] });
  if (permitted) {
    assert.deepEqual(await harness.select(), {
      hostname: "github.com",
      address,
      family,
      port: 443,
    });
  } else {
    await harness.refuses("address-denied");
  }
}
