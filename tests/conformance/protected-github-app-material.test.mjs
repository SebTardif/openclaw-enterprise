import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import test from "node:test";
import { sealProtectedKubernetesGitHubAppKeyV1 } from "../../apps/controller/src/drivers/secret/kubernetes/protected-github-app-material.ts";
import {
  admittedGitHubCredentialsFixture,
  appKeyIdentity,
  jwtCallBounds,
  protectedGitHubAppMaterialFixture,
  verifyJwtSignature,
} from "../helpers/protected-github-app-material.mjs";

// Only CoreV1Api's external read boundary is substituted. Production envelope
// crypto, protected key-file checks, source validation and RSA JWT signing run.
// This proves neither live Kubernetes access nor OCE authority/admission.
test("immutable Kubernetes source decrypts actual protected RSA envelope and rereads on every use", async (t) => {
  const fixture = await protectedGitHubAppMaterialFixture(t);
  const material = fixture.createMaterial();
  for (let call = 0; call < 2; call++) {
    const result = await material.withJwt(
      appKeyIdentity,
      jwtCallBounds(),
      async (jwt, assertCurrent) => {
        assertCurrent();
        const { header, claims } = verifyJwtSignature(jwt, fixture.publicKey);
        assert.equal(claims.iss, appKeyIdentity.clientId);
        assert.ok(claims.exp * 1000 <= Date.now() + 5000);
        assert.equal(header.alg, "RS256");
        return "consumed";
      },
    );
    assert.equal(result, "consumed");
  }
  assert.equal(fixture.reads.length, 8);
  assert.deepEqual(fixture.reads[1], ["secret", { namespace: "fixture", name: "github-app-key" }]);
  assert.ok(!JSON.stringify(fixture.secret).includes("PRIVATE KEY"));
});

test("exact immutable source and namespace ownership failures never reach JWT consumer", async (t) => {
  const mutations = [
    {
      name: "namespace UID",
      mutate: (fixture) => {
        fixture.namespace.metadata.uid = "recreated";
      },
    },
    {
      name: "namespace ownership",
      mutate: (fixture) => {
        fixture.namespace.metadata.labels["openclaw.dev/namespace"] = "ns_other";
      },
    },
    {
      name: "namespace deletion",
      mutate: (fixture) => {
        fixture.namespace.metadata.deletionTimestamp = "2026-01-01T00:00:00Z";
      },
    },
    {
      name: "mutable Secret",
      mutate: (fixture) => {
        fixture.secret.immutable = false;
      },
    },
    {
      name: "Secret UID",
      mutate: (fixture) => {
        fixture.secret.metadata.uid = "recreated";
      },
    },
    {
      name: "resourceVersion",
      mutate: (fixture) => {
        fixture.secret.metadata.resourceVersion = "74";
      },
    },
    {
      name: "driver",
      mutate: (fixture) => {
        fixture.secret.metadata.annotations["openclaw.dev/secret-driver-id"] = "other";
      },
    },
    {
      name: "binding",
      mutate: (fixture) => {
        fixture.secret.metadata.annotations["openclaw.dev/github-binding-ref"] = "other";
      },
    },
    {
      name: "immutable identity",
      mutate: (fixture) => {
        fixture.secret.metadata.annotations["openclaw.dev/github-immutable-version"] = "version/2";
      },
    },
    {
      name: "model envelope marker",
      mutate: (fixture) => {
        fixture.secret.metadata.annotations["openclaw.dev/protected-material"] =
          "model-api-key-aes256gcm-v1";
      },
    },
    {
      name: "additional key",
      mutate: (fixture) => {
        fixture.secret.data.extra = fixture.secret.data.key;
      },
    },
    {
      name: "ciphertext digest",
      mutate: (fixture) => {
        const data = Buffer.from(fixture.secret.data.key, "base64");
        data[data.length - 1] ^= 1;
        fixture.secret.data.key = data.toString("base64");
      },
    },
  ];
  for (const { name, mutate } of mutations)
    await t.test(name, async (t) => {
      const fixture = await protectedGitHubAppMaterialFixture(t);
      mutate(fixture);
      let called = false;
      await assert.rejects(
        fixture.createMaterial().withJwt(appKeyIdentity, jwtCallBounds(), async () => {
          called = true;
        }),
        /GitHub App token issuer unavailable/,
      );
      assert.equal(called, false);
    });
});

test("authenticated ciphertext cannot move to another locator even with a matching digest", async (t) => {
  const fixture = await protectedGitHubAppMaterialFixture(t);
  fixture.secret.metadata.name = "other-key";
  let consumerEntered = false;
  await assert.rejects(
    fixture
      .createMaterial({ source: { ...fixture.source, name: "other-key" } })
      .withJwt(appKeyIdentity, jwtCallBounds(), async () => {
        consumerEntered = true;
      }),
    /GitHub App token issuer unavailable/,
  );
  assert.equal(consumerEntered, false);
});

test("startup source and concrete method selection cannot change through caller mutation", async (t) => {
  const fixture = await protectedGitHubAppMaterialFixture(t);
  const source = structuredClone(fixture.source);
  const material = fixture.createMaterial({ source });
  source.uid = "replacement";
  source.keyIdentity.bindingRef = "other-binding";
  fixture.client.readNamespacedSecret = async () => {
    throw new Error("replaced client method");
  };
  fixture.crypto.open = () => {
    throw new Error("replaced crypto method");
  };
  fixture.crypto.assertAvailable = () => {
    throw new Error("replaced crypto method");
  };
  assert.equal(
    await material.withJwt(appKeyIdentity, jwtCallBounds(), async () => "fixed selection"),
    "fixed selection",
  );
});

test("protected master key is checked after API awaits and at consumer continuations", async (t) => {
  await t.test("master removed during read", async (t) => {
    const fixture = await protectedGitHubAppMaterialFixture(t);
    const client = {
      ...fixture.client,
      async readNamespacedSecret(request) {
        const result = await fixture.client.readNamespacedSecret(request);
        await rm(fixture.keyFile);
        return result;
      },
    };
    let consumerEntered = false;
    await assert.rejects(
      fixture.createMaterial({ client }).withJwt(appKeyIdentity, jwtCallBounds(), async () => {
        consumerEntered = true;
      }),
    );
    assert.equal(consumerEntered, false);
  });
  await t.test("master permissions change during consumer", async (t) => {
    const fixture = await protectedGitHubAppMaterialFixture(t);
    let continuationRejected = false;
    await assert.rejects(
      fixture
        .createMaterial()
        .withJwt(appKeyIdentity, jwtCallBounds(), async (_jwt, assertCurrent) => {
          await chmod(fixture.keyFile, 0o644);
          assert.throws(assertCurrent);
          continuationRejected = true;
          return "must not transfer";
        }),
    );
    // A consumer assertion error is wrapped too; observe successful checking separately.
    assert.equal(continuationRejected, true);
  });
});

test("source replacement after JWT consumption rejects the returned result on source recheck", async (t) => {
  const fixture = await protectedGitHubAppMaterialFixture(t);
  let consumerEntered = false;
  await assert.rejects(
    fixture.createMaterial().withJwt(appKeyIdentity, jwtCallBounds(), async () => {
      consumerEntered = true;
      fixture.secret.metadata.uid = "replacement";
      return "must not transfer";
    }),
  );
  assert.equal(consumerEntered, true);
  assert.equal(fixture.reads.length, 4);
});

test("cancellation, closure, busy ownership and expired bounds fail closed", async (t) => {
  for (const stop of ["cancellation", "closure"])
    await t.test(stop, async (t) => {
      const fixture = await protectedGitHubAppMaterialFixture(t);
      const material = fixture.createMaterial();
      let release;
      let entered;
      const entering = new Promise((resolve) => {
        entered = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      let continuationRejected = false;
      const pending = material.withJwt(
        appKeyIdentity,
        { ...jwtCallBounds(), signal: controller.signal },
        async (_jwt, assertCurrent) => {
          assertCurrent();
          entered();
          await gate;
          assert.throws(assertCurrent);
          continuationRejected = true;
        },
      );
      await entering;
      await assert.rejects(material.withJwt(appKeyIdentity, jwtCallBounds(), async () => {}));
      // Each stop must independently invalidate the suspended consumer.
      if (stop === "cancellation") controller.abort();
      else material.close();
      release();
      await assert.rejects(pending);
      // The owner also wraps consumer assertion errors, so check this separately.
      assert.equal(continuationRejected, true);
      if (stop === "closure")
        await assert.rejects(material.withJwt(appKeyIdentity, jwtCallBounds(), async () => {}));
      else
        assert.equal(
          await material.withJwt(appKeyIdentity, jwtCallBounds(), async () => "fresh invocation"),
          "fresh invocation",
        );
    });
  const fixture = await protectedGitHubAppMaterialFixture(t);
  await assert.rejects(
    fixture
      .createMaterial()
      .withJwt(appKeyIdentity, { ...jwtCallBounds(), deadline: 1 }, async () => {}),
  );
});

test(
  "owner lifetime expires independently of a frozen wall clock",
  { timeout: 10000 },
  async (t) => {
    const fixture = await protectedGitHubAppMaterialFixture(t);
    const now = Date.now();
    let continuationRejected = false;
    await assert.rejects(
      fixture
        .createMaterial({ clock: () => now })
        .withJwt(
          appKeyIdentity,
          { ...jwtCallBounds(), deadline: now + 30000 },
          async (_jwt, assertCurrent) => {
            await new Promise((resolve) => setTimeout(resolve, 5050));
            assert.throws(assertCurrent);
            continuationRejected = true;
          },
        ),
    );
    assert.equal(continuationRejected, true);
  },
);

test("import rejects non-RSA material and use requires the exact fixed key identity", async (t) => {
  const fixture = await protectedGitHubAppMaterialFixture(t);
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.throws(() =>
    sealProtectedKubernetesGitHubAppKeyV1(
      fixture.crypto,
      fixture.locator,
      Buffer.from(ec.privateKey.export({ type: "pkcs8", format: "pem" })),
    ),
  );
  const material = fixture.createMaterial();
  await assert.rejects(
    material.withJwt(
      { ...appKeyIdentity, immutableVersion: "version/2" },
      jwtCallBounds(),
      async () => {},
    ),
  );
  assert.equal(fixture.reads.length, 0);
});

test("admitted binding selects protected signing material and withdrawal stops later use", async (t) => {
  const {
    materialFixture: fixture,
    state,
    binding,
    keyIdentity,
    prepareCredentials,
  } = await admittedGitHubCredentialsFixture(t);
  for (const patch of [
    { repositoryId: 4 },
    { appId: 2 },
    { installationId: 3 },
    { bindingGeneration: 2 },
  ])
    await assert.rejects(prepareCredentials(patch));
  assert.equal(fixture.reads.length, 0, "out-of-scope selections do not read protected material");
  const owner = await prepareCredentials();
  await owner.material.withJwt(keyIdentity, jwtCallBounds(), async (jwt, assertCurrent) => {
    assertCurrent();
    verifyJwtSignature(jwt, fixture.publicKey);
  });
  const reads = fixture.reads.length;
  await state.transact((unit) =>
    unit.repositoryBindings.updateBinding({ ...binding, generation: 2 }, 1),
  );
  let withdrawnConsumerEntered = false;
  await assert.rejects(
    owner.material.withJwt(keyIdentity, jwtCallBounds(), async () => {
      withdrawnConsumerEntered = true;
    }),
  );
  assert.equal(withdrawnConsumerEntered, false);
  assert.equal(fixture.reads.length, reads);
  owner.close();
  assert.throws(() => owner.crypto.assertAvailable());
  let closedConsumerEntered = false;
  await assert.rejects(
    owner.material.withJwt(keyIdentity, jwtCallBounds(), async () => {
      closedConsumerEntered = true;
    }),
  );
  assert.equal(closedConsumerEntered, false);
});
