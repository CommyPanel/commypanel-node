import test from "node:test";
import assert from "node:assert/strict";
import {
  AbortError, ApiError, Client, InsecureUrlError, InvalidInputError, InvalidOptionError, InvalidTokenError, InvalidUrlError,
  UnexpectedResponseError, isConflict, isForbidden, isNotFound, isRateLimited, isUnauthorized,
} from "../dist/index.js";
import { TOKEN, app, deployment, envelope, panel, reply } from "./helpers.mjs";

test("accepts the addresses it should", () => {
  for (const url of ["https://panel.example.com", "https://panel.example.com/", "https://panel.example.com:8443", "https://panel.example.com/api/v1"]) {
    assert.doesNotThrow(() => new Client(url, TOKEN), url);
  }
  for (const url of ["http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000", "http://LOCALHOST"]) {
    assert.doesNotThrow(() => new Client(url, TOKEN, { allowHttpLoopback: true }), url);
  }
});

test("refuses an address that is not https, unless it is this machine and asked for", () => {
  const cases = [
    ["http://panel.example.com", {}],
    ["http://localhost:8000", {}],
    ["http://panel.example.com", { allowHttpLoopback: true }],
    ["http://192.168.1.10", { allowHttpLoopback: true }],
    ["http://localhost.evil.example", { allowHttpLoopback: true }],
    ["ftp://panel.example.com", {}],
  ];
  for (const [url, options] of cases) {
    assert.throws(() => new Client(url, TOKEN, options), InsecureUrlError, url);
  }
});

test("refuses an address that is not a bare scheme://host[:port]", () => {
  for (const url of ["", "panel.example.com", "https://", "https://user:pw@panel.example.com", "https://panel.example.com/admin", "https://panel.example.com?x=1", "https://panel.example.com?", "https://panel.example.com#top", "https://panel.example.com/api/v2"]) {
    assert.throws(() => new Client(url, TOKEN), InvalidUrlError, JSON.stringify(url));
  }
});

test("refuses a token that cannot be one", () => {
  for (const token of ["", " ", "has space", "new\nline", "tab\t", "ctl\x01", "a".repeat(513), undefined, 42]) {
    assert.throws(() => new Client("https://panel.example.com", token), InvalidTokenError, JSON.stringify(token));
  }
});

test("refuses options that make no sense", () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { retries: -1 }, { retries: 6 }, { retries: 1.5 }, { maxResponseBytes: 0 }, { caCertPem: "not pem" }]) {
    assert.throws(() => new Client("https://panel.example.com", TOKEN, options), InvalidOptionError, JSON.stringify(options));
  }
});

test("every request carries the token only in the Authorization header", async (t) => {
  const p = await panel(reply(200, envelope({ name: "ci", abilities: ["apps:read"], apps: null, expires_at: null, last_used_at: null, owner: "Sam" })));
  t.after(p.close);

  const token = await p.client({ userAgent: "mytool/1.0" }).token();
  const req = p.last();

  assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(req.headers.accept, "application/json");
  assert.match(req.headers["user-agent"], /^mytool\/1\.0 commypanel-node\/\d/);
  assert.ok(!(req.path + req.query + req.body).includes("secretsecret"));
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/token");
  assert.deepEqual(token, { name: "ci", abilities: ["apps:read"], apps: null, expires_at: null, last_used_at: null, owner: "Sam" });
});

test("every call uses the right method, path, query and body", async (t) => {
  const dep = envelope(deployment());
  const a = envelope(app());
  const p = await panel((req, res, n, body) => {
    const key = `${req.method} ${req.url}`;
    const answers = {
      "PUT /api/v1/apps/shop/env/A_B": [201, envelope({ key: "A_B", pending_changes: true })],
      "DELETE /api/v1/apps/shop/env/A_B": [200, envelope({ key: "A_B", pending_changes: true })],
      "GET /api/v1/apps/shop/env": [200, envelope({ keys: ["A"], pending_changes: false })],
      "GET /api/v1/apps/shop/logs?tail=50": [200, envelope({ live: true, lines: 50, logs: "hi" })],
      "GET /api/v1/apps": [200, envelope([])],
      "GET /api/v1/apps/shop": [200, a],
      "GET /api/v1/apps/shop/deployments?limit=5": [200, envelope([])],
      "GET /api/v1/apps/shop/deployments/4?log=1": [200, dep],
      "POST /api/v1/apps/shop/deployments": [202, dep],
      "POST /api/v1/apps/shop/apply": [202, dep],
      "POST /api/v1/apps/shop/start": [200, a],
      "POST /api/v1/apps/shop/stop": [200, a],
      "POST /api/v1/apps/shop/restart": [200, a],
    };
    const [status, data] = answers[key] ?? [404, { error: `unexpected ${key}` }];
    reply(status, data)(req, res);
  });
  t.after(p.close);
  const c = p.client();

  await c.listApps();
  await c.getApp("shop");
  await c.listDeployments("shop", { limit: 5 });
  await c.getDeployment("shop", 4, { log: true });
  await c.startDeployment("shop");
  await c.applyChanges("shop");
  await c.startApp("shop");
  await c.stopApp("shop");
  await c.restartApp("shop");
  await c.logs("shop", { tail: 50 });
  await c.listEnv("shop");
  const set = await c.setEnv("shop", "A_B", 'va"lue');
  await c.unsetEnv("shop", "A_B");

  assert.deepEqual(p.requests.map((r) => `${r.method} ${r.path}${r.query ? `?${r.query}` : ""}`), [
    "GET /api/v1/apps", "GET /api/v1/apps/shop", "GET /api/v1/apps/shop/deployments?limit=5", "GET /api/v1/apps/shop/deployments/4?log=1",
    "POST /api/v1/apps/shop/deployments", "POST /api/v1/apps/shop/apply", "POST /api/v1/apps/shop/start", "POST /api/v1/apps/shop/stop",
    "POST /api/v1/apps/shop/restart", "GET /api/v1/apps/shop/logs?tail=50", "GET /api/v1/apps/shop/env", "PUT /api/v1/apps/shop/env/A_B",
    "DELETE /api/v1/apps/shop/env/A_B",
  ]);
  assert.equal(p.requests[11].body, '{"value":"va\\"lue"}');
  assert.equal(p.requests[11].headers["content-type"], "application/json");
  assert.deepEqual(set, { change: { key: "A_B", pending_changes: true }, created: true });
});

test("decodes the objects as the API names them", async (t) => {
  const latest = deployment({ number: 3, status: "active", stage: "done", finished: true, succeeded: true, commit: "abc123", commit_message: "Fix", strategy: "stop_first", finished_at: "2026-11-16T10:01:00+00:00" });
  const p = await panel(reply(200, envelope(app({ deploy_strategy: "stop_first", latest_deployment: latest }))));
  t.after(p.close);

  const got = await p.client().getApp("shop");

  assert.equal(got.deploy_strategy, "stop_first");
  assert.equal(got.live_deployment, 3);
  assert.equal(got.latest_deployment.strategy, "stop_first");
  assert.equal(got.latest_deployment.commit, "abc123");
  assert.deepEqual(got.domains, ["shop.example.com"]);
});

test("setEnv tells new from replaced", async (t) => {
  for (const [status, created] of [[201, true], [200, false]]) {
    const p = await panel(reply(status, envelope({ key: "A", pending_changes: true })));
    t.after(p.close);
    const result = await p.client().setEnv("shop", "A", "v");
    assert.equal(result.created, created);
    assert.deepEqual(result.change, { key: "A", pending_changes: true });
  }
});

test("errors carry the panel's sentence and map to helpers", async (t) => {
  const cases = [
    [404, { error: "Not Found", message: "Not Found" }, isNotFound],
    [401, { error: "Unauthenticated." }, isUnauthorized],
    [403, { error: "Invalid ability provided." }, isForbidden],
    [409, { error: "A deployment is already in progress." }, isConflict],
    [429, { error: "Too Many Attempts." }, isRateLimited],
  ];
  for (const [status, body, check] of cases) {
    const p = await panel(reply(status, body));
    t.after(p.close);
    await assert.rejects(p.client({ retries: 0 }).getApp("shop"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, status);
      assert.ok(err.panelMessage.length > 0);
      assert.ok(check(err), `helper for ${status}`);
      return true;
    });
  }
});

test("a conflict names the running deployment and a validation error the fields", async (t) => {
  let p = await panel(reply(409, { error: "A deployment is already in progress.", deployment: deployment({ number: 7, status: "building" }) }));
  t.after(p.close);
  await assert.rejects(p.client().startDeployment("shop"), (err) => err instanceof ApiError && err.deployment?.number === 7);

  p = await panel(reply(422, { error: "PORT is set by CommyPanel.", errors: { key: ["PORT is set by CommyPanel."] } }));
  t.after(p.close);
  await assert.rejects(p.client().setEnv("shop", "PORT", "1"), (err) => {
    assert.deepEqual(err.fields, { key: ["PORT is set by CommyPanel."] });
    assert.match(err.message, /key: PORT is set by CommyPanel\./);
    return true;
  });
});

test("an answer that is not the API's is described without repeating it", async (t) => {
  for (const status of [200, 502]) {
    const p = await panel((req, res) => { res.writeHead(status); res.end("<html>nginx says hi</html>"); });
    t.after(p.close);
    await assert.rejects(p.client({ retries: 0 }).listApps(), (err) => {
      assert.ok(!err.message.includes("nginx says hi"));
      assert.ok(status === 200 ? err instanceof UnexpectedResponseError : err instanceof ApiError);
      return true;
    });
  }
});

test("names that cannot be right never become requests", async (t) => {
  const p = await panel(reply(200, envelope({})));
  t.after(p.close);
  const c = p.client();

  for (const slug of ["", "../etc", "a/b", "A", "a b", "-x", "a?x=1", "a#b", "a%2Fb", "a".repeat(64), null, undefined, 5]) {
    await assert.rejects(c.getApp(slug), InvalidInputError, `slug ${JSON.stringify(slug)}`);
  }
  for (const key of ["", "1BAD", "A-B", "A B", "A/B", "A?", "A".repeat(129), null]) {
    await assert.rejects(c.setEnv("shop", key, "v"), InvalidInputError, `key ${JSON.stringify(key)}`);
    await assert.rejects(c.unsetEnv("shop", key), InvalidInputError, `unset key ${JSON.stringify(key)}`);
  }
  await assert.rejects(c.setEnv("shop", "A", 5), InvalidInputError);
  for (const number of [0, -1, 1.5, "4", NaN]) {
    await assert.rejects(c.getDeployment("shop", number), InvalidInputError, `number ${number}`);
  }
  assert.equal(p.requests.length, 0, "no request may be made for invalid names");
});

test("an already aborted signal makes no request", async (t) => {
  const p = await panel(reply(200, envelope([])));
  t.after(p.close);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(p.client().listApps({ signal: controller.signal }), AbortError);
  assert.equal(p.requests.length, 0);
});

test("a request that takes too long times out", async (t) => {
  const p = await panel(() => { /* never answers */ });
  t.after(p.close);

  await assert.rejects(p.client({ timeoutMs: 100, retries: 0 }).listApps(), (err) => err.name === "TimeoutError");
});

test("waitForDeployment polls until it is over, and an abort stops the waiting", async (t) => {
  const p = await panel((req, res, n) => {
    const finished = n >= 3;
    reply(200, envelope(deployment({ status: finished ? "active" : "building", finished, succeeded: finished })))(req, res);
  });
  t.after(p.close);
  const c = p.client();

  let looks = 0;
  const done = await c.waitForDeployment("shop", 4, { pollMs: 1000, onUpdate: () => looks++ });
  assert.ok(done.finished && done.succeeded);
  assert.equal(looks, 3);
  assert.deepEqual(c.waits, [1000, 1000]);

  // Faster than a second is not allowed: it falls back to the default.
  const q = await panel(reply(200, envelope(deployment({ status: "building" }))));
  t.after(q.close);
  const c2 = q.client();
  const controller = new AbortController();
  c2.sleep = async (ms, signal) => { c2.waits.push(ms); controller.abort(); if (signal?.aborted) throw new AbortError(); };
  await assert.rejects(c2.waitForDeployment("shop", 4, { pollMs: 10, signal: controller.signal }), AbortError);
  assert.deepEqual(c2.waits, [3000]);
});
