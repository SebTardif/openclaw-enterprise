import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const localRoot = join(repository, ".build/mvp/egress-local");
const ownerLabel = "org.openclaw.egress.owner";
let selectedDockerHost;
const supportedFields = new Set([
  "schemaVersion",
  "project",
  "image",
  "authoritySocketDirectory",
  "providerKeyPath",
  "providerBindingRef",
  "credentialBinding",
  "certificatePath",
  "certificateKeyPath",
  "dnsUpstream",
]);
const credentialBindingFields = [
  "provider_binding_ref",
  "service_account_id",
  "credential_profile_ref",
  "provider_profile_ref",
  "audience_ref",
  "transport_profile_ref",
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateConfiguration(value) {
  requireValue(
    value?.schemaVersion === 1 && Object.keys(value).every((key) => supportedFields.has(key)),
    "unsupported local egress configuration",
  );
  requireValue(
    typeof value.project === "string" && /^oce-egress-[a-z0-9-]{1,32}$/.test(value.project),
    "project must have the form oce-egress-<local-name>",
  );
  requireValue(
    typeof value.image === "string" &&
      /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64})$/.test(value.image),
    "image must be a local image ID or a registry manifest digest reference",
  );
  requireValue(
    typeof value.providerBindingRef === "string" &&
      /^[a-zA-Z0-9._:-]{1,128}$/.test(value.providerBindingRef),
    "providerBindingRef must identify an existing configured authority route",
  );
  const binding = value.credentialBinding;
  requireValue(
    binding !== null &&
      typeof binding === "object" &&
      !Array.isArray(binding) &&
      Object.keys(binding).length === credentialBindingFields.length &&
      Object.keys(binding).every((key) => credentialBindingFields.includes(key)),
    "credentialBinding must contain exactly the six provisioned credential descriptor fields",
  );
  for (const field of credentialBindingFields) {
    requireValue(
      typeof binding[field] === "string" && /^[\x21-\x7e]{1,128}$/.test(binding[field]),
      `credentialBinding.${field} must be a provisioned reference of 1 to 128 nonspace ASCII characters`,
    );
  }
  requireValue(
    binding.provider_binding_ref === value.providerBindingRef,
    "credentialBinding.provider_binding_ref must equal providerBindingRef",
  );
  requireValue(
    typeof value.dnsUpstream === "string" &&
      value.dnsUpstream.endsWith(":53") &&
      isIP(value.dnsUpstream.slice(0, -3)) === 4,
    "dnsUpstream must be an explicit IPv4 resolver on port 53",
  );
  requireValue(
    !/^(?:0|127|22[4-9]|23[0-9])\./.test(value.dnsUpstream) &&
      value.dnsUpstream !== "255.255.255.255:53",
    "dnsUpstream must be a reachable unicast resolver outside container loopback",
  );
  for (const field of [
    "authoritySocketDirectory",
    "providerKeyPath",
    "certificatePath",
    "certificateKeyPath",
  ]) {
    requireValue(
      typeof value[field] === "string" &&
        value[field].startsWith("/") &&
        !/[\x00-\x1f\x7f]/.test(value[field]),
      `${field} must be an absolute local path`,
    );
  }
  return value;
}

async function regularFile(path) {
  const stat = await lstat(path);
  requireValue(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size > 0 &&
      stat.size <= 1024 * 1024 &&
      (stat.mode & 0o022) === 0,
    "runtime input must be a bounded, nonempty, non-writable regular file",
  );
  requireValue(
    (await realpath(path)) === resolve(path),
    "runtime inputs must use canonical paths without symbolic links",
  );
  // Docker bind mounts retain inode ownership. UID 10002 must actually be able
  // to read the file, without making the host secret visible outside its owner.
  requireValue(
    (stat.uid === 10002 && (stat.mode & 0o400) !== 0) || (stat.mode & 0o004) !== 0,
    "TLS UID 10002 cannot read the selected bind-mounted file",
  );
  return stat;
}

async function secretFile(path) {
  const stat = await regularFile(path);
  const parent = await lstat(dirname(path));
  requireValue(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      parent.uid === process.getuid() &&
      (parent.mode & 0o077) === 0,
    "secret source files need a caller-owned private parent directory (mode 0700)",
  );
  requireValue(
    [process.getuid(), 10002].includes(stat.uid),
    "secret source file has an unexpected owner",
  );
}

export async function checkInputs(config) {
  validateConfiguration(config);
  await secretFile(config.providerKeyPath);
  await secretFile(config.certificateKeyPath);
  await regularFile(config.certificatePath);
  const parent = await lstat(config.authoritySocketDirectory);
  requireValue(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      parent.uid === 10003 &&
      (parent.mode & 0o022) === 0 &&
      (parent.mode & 0o001) !== 0,
    "authority socket directory must be owned by UID 10003 and not writable by consumers",
  );
  requireValue(
    (await realpath(config.authoritySocketDirectory)) === resolve(config.authoritySocketDirectory),
    "authority socket directory must be a canonical path",
  );
  const socket = await lstat(join(config.authoritySocketDirectory, "authority.sock"));
  requireValue(
    socket.isSocket() && socket.uid === 10003 && (socket.mode & 0o002) !== 0,
    "a real authority.sock owned by UID 10003 must already exist and admit consumer connections",
  );
}

function bind(source, target) {
  // Compose interpolates dollar signs even in JSON input. Keep the mounted path
  // identical to the local file whose ownership and permissions were checked.
  return {
    type: "bind",
    source: source.replaceAll("$", () => "$$"),
    target,
    read_only: true,
    bind: { create_host_path: false },
  };
}

export function createCompose(config, stateDirectory, owner) {
  requireValue(
    typeof owner === "string" && /^[a-f0-9-]{36}$/.test(owner),
    "an exclusive local project owner is required",
  );
  const labels = { [ownerLabel]: owner };
  const authority = bind(config.authoritySocketDirectory, "/run/oce-authority");
  const security = {
    image: config.image,
    pull_policy: "never",
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    pids_limit: 128,
    mem_limit: "256m",
    cpus: 1,
    restart: "no",
    stop_grace_period: "10s",
    labels,
  };
  return {
    services: {
      dns: {
        ...security,
        user: "0:0",
        cap_add: ["NET_ADMIN"],
        entrypoint: ["/usr/local/bin/oce-dnsgate"],
        command: [
          "--socket",
          "/run/oce-dns/admission.sock",
          "--authority-socket",
          "/run/oce-authority/authority.sock",
          "--upstream",
          config.dnsUpstream,
          "--policy-file",
          "/etc/oce/dns-policy.yaml",
          "--ingress-port",
          "8443",
        ],
        ports: [{ target: 8443, published: "8443", host_ip: "127.0.0.1", protocol: "tcp" }],
        volumes: [
          authority,
          bind(join(stateDirectory, "dns-policy.yaml"), "/etc/oce/dns-policy.yaml"),
          { type: "volume", source: "dns-socket", target: "/run/oce-dns" },
        ],
      },
      tls: {
        ...security,
        user: "10002:10002",
        init: true,
        network_mode: "service:dns",
        depends_on: { dns: { condition: "service_started" } },
        entrypoint: ["/usr/local/bin/oce-start-tls"],
        command: ["/etc/oce/egress.json"],
        healthcheck: {
          test: ["CMD", "/usr/local/bin/oce-egress", "--config", "/etc/oce/egress.json", "--ready"],
          interval: "2s",
          timeout: "5s",
          retries: 3,
          start_period: "5s",
        },
        volumes: [
          authority,
          bind(join(stateDirectory, "egress.json"), "/etc/oce/egress.json"),
          bind(config.providerKeyPath, "/run/oce-provider/key"),
          bind(config.certificatePath, "/run/oce-tls/certificate.pem"),
          bind(config.certificateKeyPath, "/run/oce-tls/key.pem"),
          { type: "volume", source: "dns-socket", target: "/run/oce-dns", read_only: true },
        ],
      },
    },
    volumes: { "dns-socket": { name: `${config.project}-${owner}-dns-socket`, labels } },
    networks: { default: { name: `${config.project}-${owner}-network`, labels } },
  };
}

export function createTlsConfiguration(config) {
  validateConfiguration(config);
  return {
    listen: "0.0.0.0:8443",
    listener_authority: "localhost:8443",
    authority_socket: "/run/oce-authority/authority.sock",
    dns_socket: "/run/oce-dns/admission.sock",
    provider_key_path: "/run/oce-provider/key",
    provider_binding_ref: config.providerBindingRef,
    credential_binding: Object.fromEntries(
      credentialBindingFields.map((field) => [field, config.credentialBinding[field]]),
    ),
    root_ca_path: "/etc/ssl/certs/ca-certificates.crt",
    incoming_certificate_path: "/run/oce-tls/certificate.pem",
    incoming_key_path: "/run/oce-tls/key.pem",
    max_concurrent: 2,
    response_idle_timeout_ms: 300_000,
  };
}

function runCompose(project, stateDirectory, args) {
  requireValue(selectedDockerHost, "a local Docker endpoint must be selected first");
  const result = spawnSync(
    "docker",
    [
      "--host",
      selectedDockerHost,
      "compose",
      "--project-name",
      project,
      "--file",
      join(stateDirectory, "compose.json"),
      ...args,
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  requireValue(!result.error && result.status === 0, "the local Docker Compose operation failed");
}

function requireLocalDocker() {
  const context = JSON.parse(
    execFileSync("docker", ["context", "inspect"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }),
  );
  const endpoint = process.env.DOCKER_HOST || context[0]?.Endpoints?.docker?.Host;
  requireValue(
    typeof endpoint === "string" && endpoint.startsWith("unix://") && !process.env.DOCKER_CONTEXT,
    "local egress requires an explicitly selected local Unix-socket Docker context without DOCKER_CONTEXT override",
  );
  selectedDockerHost = endpoint;
  const id = docker(["info", "--format", "{{.ID}}"]);
  requireValue(id.length > 0 && id.length <= 128, "Docker daemon identity is unavailable");
  return id;
}

function docker(args) {
  requireValue(selectedDockerHost, "a local Docker endpoint must be selected first");
  return execFileSync("docker", ["--host", selectedDockerHost, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

function projectResources(project) {
  const filter = `label=com.docker.compose.project=${project}`;
  return [
    ["container", docker(["ps", "--all", "--quiet", "--filter", filter])],
    ["network", docker(["network", "ls", "--quiet", "--filter", filter])],
    ["volume", docker(["volume", "ls", "--quiet", "--filter", filter])],
  ].flatMap(([kind, output]) =>
    output
      .split("\n")
      .filter(Boolean)
      .map((id) => ({ kind, id })),
  );
}

function assertOwnedResources(project, owner) {
  const resources = projectResources(project);
  // Compose can reuse unlabelled named volumes/networks. Inspect the exact
  // per-run names too before either startup or removal.
  for (const [kind, name] of [
    ["volume", `${project}-${owner}-dns-socket`],
    ["network", `${project}-${owner}-network`],
  ]) {
    const names = docker([kind, "ls", "--format", "{{.Name}}", "--filter", `name=${name}`]).split(
      "\n",
    );
    if (names.includes(name)) resources.push({ kind, id: name });
  }
  for (const { kind, id } of resources) {
    const [resource] = JSON.parse(docker(["inspect", "--type", kind, id]));
    const labels = kind === "container" ? resource.Config?.Labels : resource.Labels;
    requireValue(
      labels?.[ownerLabel] === owner,
      "refusing to change a Docker project containing resources from another owner",
    );
  }
}

function claimProject(project, owner) {
  requireValue(
    projectResources(project).length === 0,
    "the selected Docker project already has resources; choose a different project name",
  );
  const claim = `${project}-owner`;
  // Docker volume creation is atomic. Inspect the retained labels afterwards:
  // concurrent launchers cannot both acquire an existing differently owned claim.
  docker([
    "volume",
    "create",
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    `${ownerLabel}=${owner}`,
    claim,
  ]);
  const [volume] = JSON.parse(docker(["volume", "inspect", claim]));
  requireValue(
    volume.Labels?.[ownerLabel] === owner,
    "the selected Docker project is owned by another launch",
  );
  return claim;
}

function composeDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const [command, input] = process.argv.slice(2);
  requireValue(
    process.argv.length === 4 && ["check", "up", "down"].includes(command),
    "usage: node deploy/egress/local.mjs check|up <config.json> | down <oce-egress-name>",
  );
  requireValue(
    process.platform === "linux" && process.arch === "x64",
    "local egress currently requires linux/amd64",
  );
  if (command === "down") {
    requireValue(/^oce-egress-[a-z0-9-]{1,32}$/.test(input), "invalid local egress project");
    const stateDirectory = join(localRoot, input);
    const state = await lstat(stateDirectory);
    requireValue(
      state.isDirectory() &&
        !state.isSymbolicLink() &&
        state.uid === process.getuid() &&
        (state.mode & 0o077) === 0,
      "local egress state directory has an unexpected owner or permissions",
    );
    const marker = JSON.parse(await readFile(join(stateDirectory, "owner.json"), "utf8"));
    requireValue(
      marker.project === input && marker.uid === process.getuid(),
      "local egress state is not owned by this caller",
    );
    requireValue(
      requireLocalDocker() === marker.daemon,
      "local egress state belongs to a different Docker daemon",
    );
    requireValue(
      composeDigest(await readFile(join(stateDirectory, "compose.json"))) === marker.composeDigest,
      "generated Compose configuration has changed",
    );
    const [claim] = JSON.parse(docker(["volume", "inspect", `${input}-owner`]));
    requireValue(
      claim.Labels?.[ownerLabel] === marker.owner,
      "local egress project ownership is unavailable",
    );
    assertOwnedResources(input, marker.owner);
    runCompose(input, stateDirectory, ["down", "--volumes"]);
    docker(["volume", "rm", `${input}-owner`]);
    await rm(stateDirectory, { recursive: true });
    return;
  }
  const config = validateConfiguration(JSON.parse(await readFile(resolve(input), "utf8")));
  await checkInputs(config);
  if (command === "check") {
    console.log(
      "Local egress file metadata and configuration are valid. The actual services check authority and enforcement readiness on startup; provider credential validity requires an authorized provider operation.",
    );
    return;
  }
  const daemon = requireLocalDocker();
  const stateDirectory = join(localRoot, config.project);
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { mode: 0o700 });
  const owner = randomUUID();
  const compose = JSON.stringify(createCompose(config, stateDirectory, owner), null, 2);
  await writeFile(
    join(stateDirectory, "owner.json"),
    JSON.stringify({
      project: config.project,
      uid: process.getuid(),
      owner,
      daemon,
      composeDigest: composeDigest(compose),
    }),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    join(stateDirectory, "egress.json"),
    JSON.stringify(createTlsConfiguration(config), null, 2),
    { flag: "wx", mode: 0o444 },
  );
  await writeFile(
    join(stateDirectory, "dns-policy.yaml"),
    "schema_version: pol1/v0\nlayer: org\nposture: standard\nallowlist:\n  - domain: api.openai.com\n",
    { flag: "wx", mode: 0o444 },
  );
  // A private caller umask must not make these nonsecret bind-mounted configs
  // unreadable to the two distinct service UIDs.
  await chmod(join(stateDirectory, "egress.json"), 0o444);
  await chmod(join(stateDirectory, "dns-policy.yaml"), 0o444);
  await writeFile(join(stateDirectory, "compose.json"), compose, { flag: "wx", mode: 0o600 });
  claimProject(config.project, owner);
  try {
    assertOwnedResources(config.project, owner);
    runCompose(config.project, stateDirectory, [
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "30",
    ]);
  } catch (error) {
    console.error(
      "Startup failed; stopping this project. Its local state remains available for inspection and explicit down.",
    );
    assertOwnedResources(config.project, owner);
    runCompose(config.project, stateDirectory, ["down", "--volumes"]);
    throw error;
  }
  console.log(
    "Egress is listening on https://localhost:8443. Only an admitted workload bearer and canonical turn can authorize a provider request.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Local egress failed: ${error.message}`);
    process.exitCode = 1;
  });
}
