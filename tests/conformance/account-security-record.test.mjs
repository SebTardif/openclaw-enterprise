import assert from "node:assert/strict";
import test from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { createAccountSecurityTablesV1 } from "../../packages/occ/src/state/schema/account-security.ts";
import {
  occSchema,
  installation,
  user,
  account,
} from "../../packages/occ/src/state/postgres-schema.ts";

// These use the real schema factory and original parent objects. They establish
// the declared storage graph, not PostgreSQL CHECK/trigger execution, deferred
// FK timing, role privileges or concurrent row/advisory-lock behavior. Those
// require the separately allocated real-database verification window.
const { accountSecurityRecords } = createAccountSecurityTablesV1(occSchema, {
  installation,
  user,
  account,
});
const columns = getTableColumns(accountSecurityRecords);
const config = getTableConfig(accountSecurityRecords);
// Drizzle wraps local columns for table constraints. Compare their actual
// owning table and names; foreign parent columns below retain exact identity.
const localNames = (fields) =>
  fields.map((field) => {
    assert.equal(field.table, accountSecurityRecords);
    return field.name;
  });

test("account security declares exactly the retained nonsecret record on the original schema", () => {
  assert.equal(config.schema, "occ");
  assert.equal(getTableName(accountSecurityRecords), "account_security_records");
  assert.deepEqual(
    Object.entries(columns).map(([field, column]) => [field, column.name]),
    [
      ["installationId", "installation_id"],
      ["accountId", "account_id"],
      ["issuer", "issuer"],
      ["subject", "subject"],
      ["incarnation", "incarnation"],
      ["accountVersion", "account_version"],
      ["state", "state"],
      ["currentUserId", "current_user_id"],
      ["credentialAccountId", "credential_account_id"],
    ],
  );
});

test("identity and writer version are required without fabricated schema defaults", () => {
  assert.equal(config.primaryKeys.length, 1);
  assert.deepEqual(localNames(config.primaryKeys[0].columns), ["installation_id", "account_id"]);
  for (const name of [
    "installationId",
    "accountId",
    "issuer",
    "subject",
    "incarnation",
    "accountVersion",
    "state",
  ]) {
    assert.equal(columns[name].notNull, true, name);
    assert.equal(columns[name].hasDefault, false, `${name} has no inferred value`);
  }
  assert.equal(columns.incarnation.getSQLType(), "uuid");
  assert.equal(columns.accountVersion.getSQLType(), "bigint");
});

test("immutable identity stays retained while only live locators reference deletable parents", () => {
  assert.equal(columns.currentUserId.notNull, false);
  assert.equal(columns.credentialAccountId.notNull, false);
  assert.equal(config.foreignKeys.length, 3);
  const parent = config.foreignKeys.find(
    (fk) => localNames(fk.reference().columns)[0] === "installation_id",
  );
  assert.ok(parent);
  assert.deepEqual(parent.reference().foreignColumns, [installation.id]);
  assert.equal(parent.reference().foreignTable, installation);
  assert.equal(parent.onDelete, "restrict");
  assert.equal(parent.onUpdate, "restrict");
  for (const field of [columns.accountId, columns.subject, columns.incarnation])
    assert.equal(
      config.foreignKeys.some((fk) => localNames(fk.reference().columns).includes(field.name)),
      false,
    );
});

test("live credential correspondence references the actual account PK, not provider account_id", () => {
  for (const [local, original] of [
    [columns.currentUserId, user.id],
    [columns.credentialAccountId, account.id],
  ]) {
    const fk = config.foreignKeys.find(
      (candidate) => localNames(candidate.reference().columns)[0] === local.name,
    );
    assert.ok(fk);
    assert.deepEqual(localNames(fk.reference().columns), [local.name]);
    assert.deepEqual(fk.reference().foreignColumns, [original]);
    assert.equal(fk.onDelete, "no action");
    assert.equal(fk.onUpdate, "no action");
  }
  assert.equal(
    config.foreignKeys.some((fk) => fk.reference().foreignColumns.includes(account.accountId)),
    false,
  );
});

test("incarnation and each live locator are independently unique without making tombstones nonnull", () => {
  assert.deepEqual(
    config.uniqueConstraints.map((constraint) => localNames(constraint.columns)),
    [["incarnation"], ["current_user_id"], ["credential_account_id"]],
  );
  assert.equal(columns.currentUserId.hasDefault, false);
  assert.equal(columns.credentialAccountId.hasDefault, false);
});

test("the factory requires all original parent columns instead of inventing fallback tables", () => {
  for (const missing of ["installation", "user", "account"]) {
    const parents = { installation, user, account, [missing]: undefined };
    assert.throws(() => createAccountSecurityTablesV1(occSchema, parents), /original.*parents/);
  }
});
