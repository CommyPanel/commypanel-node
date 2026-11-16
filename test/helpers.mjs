import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { Client } from "../dist/index.js";

export const TOKEN = "7|cpt_secretsecretsecretsecretsecretsecret";

export const tlsFile = (name) => fs.readFileSync(new URL(`../testdata/tls/${name}`, import.meta.url));

/**
 * A fake panel. `handler(req, res, n, body)` answers; every request is recorded in `requests`.
 * Plain http on 127.0.0.1 unless `tls` is true.
 */
export async function panel(handler, { tls = false } = {}) {
  const requests = [];
  const listener = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, "http://x");
      requests.push({ method: req.method, path: url.pathname, query: url.search.slice(1), body, headers: req.headers });
      handler(req, res, requests.length, body);
    });
  };
  const server = tls
    ? https.createServer({ key: tlsFile("server-key.pem"), cert: tlsFile("server.pem") }, listener)
    : http.createServer(listener);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`;

  return {
    url,
    requests,
    server,
    last: () => requests[requests.length - 1],
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    /** A client that does not really sleep between retries. */
    client(options = {}) {
      const client = new Client(url, TOKEN, { allowHttpLoopback: !tls, ...options });
      client.sleep = async (ms, signal) => {
        client.waits.push(ms);
        if (signal?.aborted) throw new (await import("../dist/index.js")).AbortError();
      };
      client.waits = [];
      return client;
    },
  };
}

export const reply = (status, body, headers = {}) => (req, res) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

export function deployment(over = {}) {
  return {
    number: 4, status: "queued", stage: null, finished: false, succeeded: false, commit: null, commit_message: null,
    strategy: "rolling", is_rollback: false, error: null, created_at: null, finished_at: null,
    url: "https://x/api/v1/apps/shop/deployments/4", ...over,
  };
}

export function app(over = {}) {
  return {
    slug: "shop", name: "Shop", status: "running", stack: "go", deploy_strategy: "rolling", domains: ["shop.example.com"],
    live_deployment: 3, latest_deployment: null, created_at: "2026-11-16T10:00:00+00:00", ...over,
  };
}

export const envelope = (data) => ({ data });
