import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Ability, Client, DeployStrategy } from "../dist/index.js";

// testdata/openapi.yaml is a copy of the API description in the panel repository (scripts/sync-spec.sh).
// These tests fail when the API gains a call this library does not have, or an ability it does not know,
// so the library cannot quietly fall behind. They read the file with regular expressions: no YAML dependency.

const spec = fs.readFileSync(new URL("../testdata/openapi.yaml", import.meta.url), "utf8");

/** The Client method that implements each operation of the spec. */
const methodOf = {
  getToken: "token",
  listApps: "listApps",
  getApp: "getApp",
  listDeployments: "listDeployments",
  startDeployment: "startDeployment",
  getDeployment: "getDeployment",
  applyChanges: "applyChanges",
  startApp: "startApp",
  stopApp: "stopApp",
  restartApp: "restartApp",
  getLogs: "logs",
  listEnv: "listEnv",
  setEnv: "setEnv",
  unsetEnv: "unsetEnv",
};

test("every operation of the spec has a method, and no method is left over", () => {
  const ids = [...spec.matchAll(/^\s+operationId:\s*(\w+)\s*$/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 14, `found only ${ids.length} operations in the spec`);

  for (const id of ids) {
    const name = methodOf[id];
    assert.ok(name, `the spec has the operation "${id}" and this library has no method for it`);
    assert.equal(typeof Client.prototype[name], "function", `operation "${id}" should be Client.${name}`);
  }
  for (const id of Object.keys(methodOf)) {
    assert.ok(ids.includes(id), `the library maps "${id}", which is no longer in the spec`);
  }
});

test("the spec's abilities are the library's", () => {
  const used = new Set([...spec.matchAll(/x-ability:\s*['"]?([\w:]+)['"]?/g)].map((m) => m[1]));
  const known = new Set(Object.values(Ability));

  for (const ability of used) assert.ok(known.has(ability), `the spec uses the ability "${ability}", which the library does not define`);
  for (const ability of known) assert.ok(used.has(ability), `the library defines "${ability}", which the spec does not use`);
});

test("the spec's deploy modes are the library's", () => {
  for (const mode of Object.values(DeployStrategy)) {
    assert.match(spec, new RegExp(`^\\s+-\\s*${mode}\\s*$`, "m"), `deploy mode "${mode}" is not in the spec`);
  }
});

test("the spec's Deployment and App objects have the fields the types name", () => {
  for (const field of ["number", "status", "stage", "finished", "succeeded", "commit", "commit_message", "strategy", "is_rollback", "error", "created_at", "finished_at", "url"]) {
    assert.match(spec, new RegExp(`^\\s+${field}:`, "m"), `Deployment.${field} is not in the spec`);
  }
  for (const field of ["slug", "name", "status", "stack", "deploy_strategy", "domains", "live_deployment", "latest_deployment", "created_at"]) {
    assert.match(spec, new RegExp(`^\\s+${field}:`, "m"), `App.${field} is not in the spec`);
  }
});
