// This package exercises the real loader and factory boundary, not Compute operations.
export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string" },
    result: { type: "string" },
  },
  required: ["label"],
};

export function validateConfiguration(configuration) {
  if (configuration.label === "reject-semantic-value") {
    throw new Error("Fixture semantic validation rejected label.");
  }
}

export function createDriver(options) {
  if (options.configuration.result === "null") return null;
  const driver = {
    id: options.id,
    implementation: options.implementation,
    capability: "compute",
    ensureNamespace() {},
    deleteNamespace() {},
    prepareRevision() {},
    retireRevision() {},
    operationAbortSignal: options.getOperationAbortSignal,
  };
  switch (options.configuration.result) {
    case "wrong-id":
      driver.id = "unselected-id";
      break;
    case "wrong-implementation":
      driver.implementation = "unselected/implementation";
      break;
    case "wrong-capability":
      driver.capability = "iam";
      break;
    case "missing-method":
      delete driver.prepareRevision;
      break;
    case "invalid-lifecycle":
      driver.setLifecycleDrivers = true;
      break;
  }
  return driver;
}
