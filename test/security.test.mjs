import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  AbortError, ApiError, Client, RedirectError, ResponseTooLargeError, TransportError,
} from "../dist/index.js";
import { redact } from "../dist/redact.js";
import { TOKEN, envelope, panel, reply, tlsFile } from "./helpers.mjs";

test("redirects are never followed, so the token stays home", async (t) => {
  const elsewhere = await panel(reply(200, envelope([])));
  const home = await panel((req, res) => { res.writeHead(302, { Location: `${elsewhere.url}/api/v1/apps` }); res.end(); });
  t.after(elsewhere.close);
  t.after(home.close);

  for (const status of [301, 302, 303, 307, 308]) {
    const redirecting = await panel((req, res) => { res.writeHead(status, { Location: `${elsewhere.url}/api/v1/apps` }); res.end(); });
    t.after(redirecting.close);
    await assert.rejects(redirecting.client().listApps(), RedirectError, `status ${status}`);
  }
  await assert.rejects(home.client().startDeployment("shop"), RedirectError);
  assert.equal(elsewhere.requests.length, 0, "the other address must receive nothing");
});

test("the token never shows up in output", async (t) => {
  const p = await panel(reply(200, envelope([])));
  const c = p.client();
  const shown = [String(c), `${c}`, inspect(c), inspect(c, { depth: 10, showHidden: true }), JSON.stringify(c), JSON.stringify({ c }), JSON.stringify(Object.entries(c))];

  for (const text of shown) {
    assert.ok(!text.includes("secretsecret"), `the token is in ${text}`);
  }
  assert.deepEqual(Object.getOwnPropertyNames(c).filter((name) => String(c[name]).includes("secretsecret")), []);

  // A failed connection must not repeat it either.
  await p.close();
  await assert.rejects(c.listApps(), (err) => {
    assert.ok(err instanceof TransportError);
    assert.ok(!err.message.includes("secretsecret") && !String(err.stack).includes("secretsecret"));
    return true;
  });
});

test("a panel that echoes the Authorization header into its error cannot make the token reach a log", async (t) => {
  const p = await panel((req, res) => reply(422, { error: `bad request from ${req.headers.authorization}`, errors: { [req.headers.authorization]: [`${req.headers.authorization} is wrong`] } })(req, res));
  t.after(p.close);

  await assert.rejects(p.client({ retries: 0 }).listApps(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 422);
    const everything = [err.message, err.panelMessage, err.stack, JSON.stringify(err.fields)].join("\n");
    assert.ok(!everything.includes("secretsecret"), "the token must not be in the error");
    assert.ok(err.panelMessage.includes("[redacted]"));
    return true;
  });
});

test("a response larger than the limit is refused, declared or streamed", async (t) => {
  const declared = await panel(reply(200, envelope({ live: true, lines: 10, logs: "x".repeat(5000) })));
  t.after(declared.close);
  await assert.rejects(declared.client({ maxResponseBytes: 1000 }).logs("shop", { tail: 10 }), ResponseTooLargeError);

  // Chunked, without a length, so it can only be caught while reading.
  const streamed = await panel((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"data":{"live":true,"lines":10,"logs":"');
    res.write("x".repeat(5000));
    res.end('"}}');
  });
  t.after(streamed.close);
  await assert.rejects(streamed.client({ maxResponseBytes: 1000 }).logs("shop", { tail: 10 }), ResponseTooLargeError);

  // An error answer is read only up to 1 MiB even when the limit is higher.
  const bigError = await panel((req, res) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "x".repeat(2 << 20) })); });
  t.after(bigError.close);
  await assert.rejects(bigError.client({ retries: 0 }).listApps(), ResponseTooLargeError);
});

test("retries: a read is retried after a gateway error", async (t) => {
  const p = await panel((req, res, n) => (n < 3 ? reply(503, { error: "down" }) : reply(200, envelope([])))(req, res));
  t.after(p.close);
  const c = p.client();

  await c.listApps();

  assert.equal(p.requests.length, 3);
  assert.deepEqual(c.waits, [500, 1000]);
});

test("retries: a write is not retried after a gateway error, it may have happened", async (t) => {
  const p = await panel(reply(503, { error: "down" }));
  t.after(p.close);

  await assert.rejects(p.client().startDeployment("shop"), ApiError);
  await assert.rejects(p.client().setEnv("shop", "A", "v"), ApiError);
  assert.equal(p.requests.length, 2);
});

test("retries: a refusal for too many calls is retried for writes too, after the wait it asks for", async (t) => {
  const p = await panel((req, res, n) => {
    if (n === 1) return reply(429, { error: "slow down" }, { "Retry-After": "7" })(req, res);
    reply(202, envelope({ number: 1, status: "queued", finished: false, succeeded: false, strategy: "rolling", is_rollback: false, url: "u" }))(req, res);
  });
  t.after(p.close);
  const c = p.client();

  const d = await c.startDeployment("shop");

  assert.equal(d.number, 1);
  assert.deepEqual(c.waits, [7000]);
  assert.equal(p.requests.length, 2);
});

test("retries: an enormous Retry-After is capped, and the limit of attempts holds", async (t) => {
  const p = await panel(reply(429, { error: "slow down" }, { "Retry-After": "86400" }));
  t.after(p.close);
  const c = p.client({ retries: 1 });

  await assert.rejects(c.listApps(), (err) => err instanceof ApiError && err.status === 429 && err.retryAfterSeconds === 86400);
  assert.deepEqual(c.waits, [30000]);
  assert.equal(p.requests.length, 2);

  const q = await panel(reply(503, { error: "down" }));
  t.after(q.close);
  await assert.rejects(q.client({ retries: 0 }).listApps(), ApiError);
  assert.equal(q.requests.length, 1);
});

test("retries: a cancelled call stops the waiting", async (t) => {
  const p = await panel(reply(503, { error: "down" }));
  t.after(p.close);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(p.client().listApps({ signal: controller.signal }), AbortError);
  assert.equal(p.requests.length, 0);

  const live = new AbortController();
  const c = p.client();
  c.sleep = async () => { live.abort(); throw new AbortError(); };
  await assert.rejects(c.listApps({ signal: live.signal }), AbortError);
  assert.equal(p.requests.length, 1);
});

test("TLS: a certificate from an authority you did not choose is refused", async (t) => {
  const p = await panel(reply(200, envelope([])), { tls: true });
  t.after(p.close);

  // The test CA is not a public one, so by default the panel is not trusted.
  await assert.rejects(new Client(p.url, TOKEN, { retries: 0 }).listApps(), (err) => err instanceof TransportError && !err.message.includes("secretsecret"));
  // Another CA does not help.
  await assert.rejects(new Client(p.url, TOKEN, { retries: 0, caCertPem: tlsFile("other-ca.pem") }).listApps(), TransportError);
  assert.equal(p.requests.length, 0, "no request may reach a server whose certificate was refused");
});

test("TLS: a private CA can be trusted on purpose", async (t) => {
  const p = await panel(reply(200, envelope([])), { tls: true });
  t.after(p.close);

  const apps = await new Client(p.url, TOKEN, { caCertPem: tlsFile("ca.pem") }).listApps();

  assert.deepEqual(apps, []);
  assert.equal(p.last().headers.authorization, `Bearer ${TOKEN}`);
});

test("TLS: there is no way to switch verification off, even by passing the usual options", async (t) => {
  const p = await panel(reply(200, envelope([])), { tls: true });
  t.after(p.close);

  // Unknown options are ignored, never handed to the TLS layer.
  for (const sneaky of [{ rejectUnauthorized: false }, { insecure: true }, { skipVerify: true }, { agent: { options: { rejectUnauthorized: false } } }]) {
    await assert.rejects(new Client(p.url, TOKEN, { retries: 0, ...sneaky }).listApps(), TransportError, JSON.stringify(sneaky));
  }
  assert.equal(p.requests.length, 0);
});

test("redact removes the token, plain and URL-encoded, wherever it is", () => {
  const encoded = encodeURIComponent(TOKEN);
  const text = `failed with ${TOKEN} and again ${TOKEN}, also ${encoded}`;

  const clean = redact(text, TOKEN);

  assert.ok(!clean.includes("secretsecret"));
  assert.equal(clean, "failed with [redacted] and again [redacted], also [redacted]");
  assert.equal(redact("nothing here", TOKEN), "nothing here");
  assert.equal(redact("anything", ""), "anything");
});
