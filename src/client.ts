import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { inspect } from "node:util";
import {
  AbortError,
  ApiError,
  CommyPanelError,
  InsecureUrlError,
  InvalidInputError,
  InvalidOptionError,
  InvalidTokenError,
  InvalidUrlError,
  RedirectError,
  ResponseTooLargeError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
} from "./errors.js";
import type {
  App,
  CallOptions,
  Deployment,
  EnvChange,
  EnvKeys,
  GetDeploymentOptions,
  ListDeploymentsOptions,
  Logs,
  LogsOptions,
  SetEnvResult,
  Token,
  WaitOptions,
} from "./types.js";
import { redact } from "./redact.js";
import { checkEnvKey, checkNumber, checkSlug } from "./validate.js";
import { VERSION } from "./version.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY = 16 << 20; // 16 MiB: far more than 5000 log lines
const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 5;
const MAX_RETRY_WAIT_MS = 30_000;
const MAX_ERROR_BODY = 1 << 20;
const BASE_PATH = "/api/v1";

/** Options for {@link Client}. */
export interface ClientOptions {
  /**
   * Allow a plain http address, but only for localhost, 127.0.0.1 or ::1 (development against a panel on
   * the same machine). Any other http address is still refused.
   */
  allowHttpLoopback?: boolean;
  /**
   * Trust one more certificate authority, in PEM, besides the usual ones. For a panel whose certificate
   * comes from a private CA. There is deliberately no option to skip verification.
   */
  caCertPem?: string | Buffer;
  /** How long one request may take, in milliseconds (default 30000). */
  timeoutMs?: number;
  /**
   * How many times a failed request may be tried again (default 2, at most 5). Only requests that are safe to
   * repeat are retried: any request the panel refused with 429, and reading calls that met 502, 503 or 504.
   */
  retries?: number;
  /** The largest answer the client will read, in bytes (default 16 MiB). */
  maxResponseBytes?: number;
  /** A name (your tool) put in front of the library's User-Agent. */
  userAgent?: string;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface Target {
  protocol: "https:" | "http:";
  /** Host without brackets, for the socket. */
  hostname: string;
  port: number;
  /** scheme://host[:port], the address the client reports. */
  base: string;
}

/**
 * Talks to one CommyPanel server with one token. Safe to use for several calls at once.
 *
 * The token is held in a private field: it is not an own property, so it cannot show up in `console.log`,
 * `JSON.stringify`, `util.inspect` or a heap snapshot of the object's properties, and error messages are
 * scrubbed of it.
 */
export class Client {
  readonly #token: string;
  readonly #target: Target;
  readonly #ca: (string | Buffer)[] | undefined;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #maxBody: number;
  readonly #agent: string;

  /** @internal Waits between retries and polls; tests replace it so they do not really wait. */
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void> = sleepFor;

  constructor(baseUrl: string, token: string, options: ClientOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new InvalidOptionError("commypanel: the timeout must be positive");
    }

    const retries = options.retries ?? DEFAULT_RETRIES;
    if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
      throw new InvalidOptionError("commypanel: retries must be between 0 and 5");
    }

    const maxBody = options.maxResponseBytes ?? DEFAULT_MAX_BODY;
    if (!Number.isFinite(maxBody) || maxBody <= 0) {
      throw new InvalidOptionError("commypanel: the limit must be positive");
    }

    const caPem = options.caCertPem;
    if (caPem !== undefined && !/-----BEGIN CERTIFICATE-----/.test(caPem.toString())) {
      throw new InvalidOptionError("commypanel: the CA certificate is not valid PEM");
    }

    this.#target = checkBaseUrl(baseUrl, options.allowHttpLoopback === true);
    checkToken(token);
    this.#token = token;
    this.#timeoutMs = timeoutMs;
    this.#retries = retries;
    this.#maxBody = maxBody;
    // A custom CA is added to the usual roots (Node's `ca` option replaces them, so they are listed too).
    this.#ca = caPem === undefined ? undefined : [...tls.rootCertificates, caPem];

    const own = options.userAgent?.trim();
    this.#agent = (own ? `${own} ` : "") + `commypanel-node/${VERSION}`;
  }

  /** The panel address the client uses (no path, no token). */
  get baseUrl(): string {
    return this.#target.base;
  }

  /** Describes the client without the token. */
  toString(): string {
    return `commypanel.Client{${this.#target.base}, token: redacted}`;
  }

  toJSON(): { baseUrl: string; token: string } {
    return { baseUrl: this.#target.base, token: "redacted" };
  }

  [inspect.custom](): string {
    return this.toString();
  }

  /**
   * Makes one call and decodes a JSON answer of the form `{"data": ...}`. Returns the HTTP status too, which
   * the caller needs to tell 200 from 201.
   * @internal
   */
  async request<T>(
    method: string,
    path: string,
    query: URLSearchParams | undefined,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; data: T }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const target = BASE_PATH + path + (query && query.size > 0 ? `?${query.toString()}` : "");

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once<T>(method, target, payload, signal);
      } catch (err) {
        if (!(err instanceof ApiError) || attempt >= this.#retries || !retryable(method, err.status)) {
          throw err;
        }

        let wait = err.retryAfterSeconds > 0 ? err.retryAfterSeconds * 1000 : 500 * 2 ** attempt;
        wait = Math.min(wait, MAX_RETRY_WAIT_MS);
        await this.sleep(wait, signal);
      }
    }
  }

  async #once<T>(
    method: string,
    target: string,
    payload: Buffer | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; data: T }> {
    let raw: RawResponse;
    try {
      raw = await this.#send(method, target, payload, signal);
    } catch (err) {
      throw this.#scrub(err);
    }

    if (raw.status >= 300 && raw.status < 400) {
      throw new RedirectError();
    }

    if (raw.status >= 400) {
      throw this.#redactApiError(parseApiError(raw));
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(raw.body.toString("utf8"));
    } catch {
      envelope = undefined;
    }

    const data = isObject(envelope) ? envelope["data"] : undefined;
    if (data === undefined) {
      throw new UnexpectedResponseError(
        `commypanel: the answer is not the JSON the API gives (is ${this.#target.base} a CommyPanel?)`,
      );
    }

    return { status: raw.status, data: data as T };
  }

  #send(method: string, target: string, payload: Buffer | undefined, outer: AbortSignal | undefined): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      if (outer?.aborted) {
        reject(new AbortError());
        return;
      }

      const headers: http.OutgoingHttpHeaders = {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/json",
        "User-Agent": this.#agent,
        // No connection reuse: nothing here depends on it, and a stale socket is one less thing to retry.
        Connection: "close",
      };
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = payload.length;
      }

      const useTls = this.#target.protocol === "https:";
      const options: https.RequestOptions = {
        method,
        hostname: this.#target.hostname,
        port: this.#target.port,
        path: target,
        headers,
        // Never reuse a pooled agent that something else configured: it could carry other TLS settings.
        agent: false,
      };
      if (useTls) {
        options.minVersion = "TLSv1.2";
        options.rejectUnauthorized = true;
        if (this.#ca) {
          options.ca = this.#ca;
        }
      }

      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outer?.removeEventListener("abort", onAbort);
        fn();
      };

      const req = (useTls ? https : http).request(options, (res) => {
        const status = res.statusCode ?? 0;
        const limit = status >= 400 ? Math.min(this.#maxBody, MAX_ERROR_BODY) : this.#maxBody;
        const declared = Number(res.headers["content-length"]);

        if (Number.isFinite(declared) && declared > limit) {
          req.destroy();
          finish(() => reject(new ResponseTooLargeError()));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            req.destroy();
            finish(() => reject(new ResponseTooLargeError()));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => finish(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })));
        res.on("error", (err) => finish(() => reject(err)));
        res.on("aborted", () => finish(() => reject(new TransportError("commypanel: the connection was closed early"))));
      });

      const onAbort = (): void => {
        req.destroy();
        finish(() => reject(new AbortError()));
      };
      const timer = setTimeout(() => {
        req.destroy();
        finish(() => reject(new TimeoutError()));
      }, this.#timeoutMs);
      outer?.addEventListener("abort", onAbort, { once: true });

      req.on("error", (err) => finish(() => reject(err)));
      req.end(payload);
    });
  }

  /** A panel that echoes the Authorization header into its error text must not make the token reach a log. */
  #redactApiError(err: ApiError): ApiError {
    const clean = (text: string): string => redact(text, this.#token);
    if (!err.panelMessage.includes(this.#token) && !JSON.stringify(err.fields).includes(this.#token)) {
      return err;
    }

    const fields: Record<string, string[]> = {};
    for (const [name, list] of Object.entries(err.fields)) {
      fields[clean(name)] = list.map(clean);
    }
    return new ApiError(err.status, clean(err.panelMessage), fields, err.deployment, err.retryAfterSeconds);
  }

  /** Turns a transport error into one that cannot repeat the token; our own errors pass through. */
  #scrub(err: unknown): Error {
    if (err instanceof CommyPanelError) {
      return err;
    }

    const original = err instanceof Error ? err : new Error(String(err));
    const code = (original as NodeJS.ErrnoException).code;
    return new TransportError(`commypanel: ${redact(original.message, this.#token)}`, typeof code === "string" ? code : undefined);
  }

  // ---- the API ----------------------------------------------------------------------------------------

  /**
   * Describes the token this client uses: its name, abilities, the apps it is limited to and when it
   * expires. Any valid token may ask; it is a good way to check a token when it is saved.
   */
  async token(options: CallOptions = {}): Promise<Token> {
    return (await this.request<Token>("GET", "/token", undefined, undefined, options.signal)).data;
  }

  /** Lists the apps the token may see (ability `apps:read`). */
  async listApps(options: CallOptions = {}): Promise<App[]> {
    return (await this.request<App[]>("GET", "/apps", undefined, undefined, options.signal)).data;
  }

  /** Returns one app (ability `apps:read`). */
  async getApp(slug: string, options: CallOptions = {}): Promise<App> {
    return (await this.request<App>("GET", appPath(slug), undefined, undefined, options.signal)).data;
  }

  /** The newest deployments of an app, newest first (ability `apps:read`). */
  async listDeployments(slug: string, options: ListDeploymentsOptions = {}): Promise<Deployment[]> {
    const path = appPath(slug, "deployments");
    const query = new URLSearchParams();
    if (options.limit !== undefined && options.limit > 0) {
      query.set("limit", String(Math.trunc(options.limit)));
    }
    return (await this.request<Deployment[]>("GET", path, query, undefined, options.signal)).data;
  }

  /** One deployment (ability `apps:read`), with the build log when `log` is true. */
  async getDeployment(slug: string, number: number, options: GetDeploymentOptions = {}): Promise<Deployment> {
    checkNumber(number);
    const path = appPath(slug, "deployments", String(number));
    const query = new URLSearchParams();
    if (options.log) {
      query.set("log", "1");
    }
    return (await this.request<Deployment>("GET", path, query, undefined, options.signal)).data;
  }

  /**
   * Queues a deployment (ability `apps:deploy`) and returns it at once; follow it with
   * {@link waitForDeployment}. If one is already running the error is a conflict ({@link isConflict}) whose
   * `deployment` is the running one.
   */
  startDeployment(slug: string, options: CallOptions = {}): Promise<Deployment> {
    return this.#queue(slug, "deployments", options);
  }

  /**
   * Makes changed variables, volumes and links take effect from the version that is already running, without
   * a build (ability `apps:deploy`). Returns the queued deployment.
   */
  applyChanges(slug: string, options: CallOptions = {}): Promise<Deployment> {
    return this.#queue(slug, "apply", options);
  }

  async #queue(slug: string, what: string, options: CallOptions): Promise<Deployment> {
    const path = appPath(slug, what);
    return (await this.request<Deployment>("POST", path, undefined, undefined, options.signal)).data;
  }

  /** Starts a stopped app (ability `apps:control`). */
  startApp(slug: string, options: CallOptions = {}): Promise<App> {
    return this.#control(slug, "start", options);
  }

  /** Stops a running app; visitors see an error until it is started again (ability `apps:control`). */
  stopApp(slug: string, options: CallOptions = {}): Promise<App> {
    return this.#control(slug, "stop", options);
  }

  /** Restarts a running app (ability `apps:control`). */
  restartApp(slug: string, options: CallOptions = {}): Promise<App> {
    return this.#control(slug, "restart", options);
  }

  async #control(slug: string, action: string, options: CallOptions): Promise<App> {
    const path = appPath(slug, action);
    return (await this.request<App>("POST", path, undefined, undefined, options.signal)).data;
  }

  /**
   * Reads the last lines of the running container's output (ability `apps:logs`). Logs often hold secrets,
   * and every read is recorded in the panel's audit log.
   */
  async logs(slug: string, options: LogsOptions = {}): Promise<Logs> {
    const path = appPath(slug, "logs");
    const query = new URLSearchParams();
    if (options.tail !== undefined && options.tail > 0) {
      query.set("tail", String(Math.trunc(options.tail)));
    }
    return (await this.request<Logs>("GET", path, query, undefined, options.signal)).data;
  }

  /** The names of an app's environment variables (ability `apps:env`). The API never returns values. */
  async listEnv(slug: string, options: CallOptions = {}): Promise<EnvKeys> {
    return (await this.request<EnvKeys>("GET", appPath(slug, "env"), undefined, undefined, options.signal)).data;
  }

  /**
   * Sets an environment variable (ability `apps:env`). The change takes effect with {@link applyChanges} or the
   * next deployment. The value is sent, never read back.
   */
  async setEnv(slug: string, key: string, value: string, options: CallOptions = {}): Promise<SetEnvResult> {
    checkEnvKey(key);
    if (typeof value !== "string") {
      throw new InvalidInputError();
    }
    const path = appPath(slug, "env", key);
    const { status, data } = await this.request<EnvChange>("PUT", path, undefined, { value }, options.signal);
    return { change: data, created: status === 201 };
  }

  /** Removes an environment variable (ability `apps:env`). A variable that is not there is a 404. */
  async unsetEnv(slug: string, key: string, options: CallOptions = {}): Promise<EnvChange> {
    checkEnvKey(key);
    const path = appPath(slug, "env", key);
    return (await this.request<EnvChange>("DELETE", path, undefined, undefined, options.signal)).data;
  }

  /**
   * Polls a deployment until it is finished and returns the final state. Check `succeeded` (and `status`) on the
   * result: a deployment can finish as failed or rolled back. Abort the signal to stop waiting; the deployment
   * itself carries on in the panel.
   */
  async waitForDeployment(slug: string, number: number, options: WaitOptions = {}): Promise<Deployment> {
    let pollMs = options.pollMs ?? 3000;
    if (!(pollMs >= 1000)) {
      pollMs = 3000;
    }

    for (;;) {
      const deployment = await this.getDeployment(slug, number, { signal: options.signal });
      options.onUpdate?.(deployment);

      if (deployment.finished) {
        return deployment;
      }

      await this.sleep(pollMs, options.signal);
    }
  }
}

function appPath(slug: string, ...rest: string[]): string {
  checkSlug(slug);
  return ["/apps", slug, ...rest].join("/");
}

function retryable(method: string, status: number): boolean {
  switch (status) {
    case 429:
      // The panel did not do the work, so any call may be repeated.
      return true;
    case 502:
    case 503:
    case 504:
      // A gateway error says nothing about whether a write happened: only reads are repeated.
      return method === "GET";
    default:
      return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterSeconds(headers: http.IncomingHttpHeaders): number {
  const raw = headers["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !/^\s*\d+\s*$/.test(value)) {
    return 0;
  }
  return Number.parseInt(value, 10);
}

function parseApiError(raw: RawResponse): ApiError {
  const retry = retryAfterSeconds(raw.headers);

  try {
    const parsed: unknown = JSON.parse(raw.body.toString("utf8"));
    if (isObject(parsed)) {
      const error = typeof parsed["error"] === "string" ? parsed["error"] : "";
      const message = typeof parsed["message"] === "string" ? parsed["message"] : "";
      if (error !== "" || message !== "") {
        return new ApiError(
          raw.status,
          error !== "" ? error : message,
          fieldsOf(parsed["errors"]),
          isObject(parsed["deployment"]) ? (parsed["deployment"] as unknown as Deployment) : null,
          retry,
        );
      }
    }
  } catch {
    // Not JSON: fall through.
  }

  // A proxy or a crash answered with something that is not the API's JSON: say what it was, not what it said.
  const text = http.STATUS_CODES[raw.status] ?? "Error";
  return new ApiError(raw.status, `${text} (not an answer from the CommyPanel API)`, {}, null, retry);
}

function fieldsOf(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (isObject(value)) {
    for (const [name, list] of Object.entries(value)) {
      if (Array.isArray(list)) {
        out[name] = list.filter((item): item is string => typeof item === "string");
      }
    }
  }
  return out;
}

function checkBaseUrl(raw: string, allowHttpLoopback: boolean): Target {
  if (typeof raw !== "string") {
    throw new InvalidUrlError();
  }
  const text = raw.trim();

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InvalidUrlError();
  }

  if (url.hostname === "" || text.includes("?") || text.includes("#") || url.username !== "" || url.password !== "") {
    throw new InvalidUrlError();
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== BASE_PATH) {
    throw new InvalidUrlError();
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  switch (url.protocol) {
    case "https:":
      break;
    case "http:":
      if (!allowHttpLoopback || !isLoopback(host)) {
        throw new InsecureUrlError();
      }
      break;
    default:
      throw new InsecureUrlError();
  }

  const protocol = url.protocol;
  const port = url.port === "" ? (protocol === "https:" ? 443 : 80) : Number(url.port);

  return { protocol, hostname: host, port, base: `${protocol}//${url.host}` };
}

function isLoopback(host: string): boolean {
  const name = host.toLowerCase();
  if (name === "localhost") {
    return true;
  }
  if (net.isIPv4(name)) {
    return name.startsWith("127.");
  }
  if (net.isIPv6(name)) {
    return name === "::1" || /^::ffff:127\./.test(name);
  }
  return false;
}

function checkToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || token === "" || token.length > 512) {
    throw new InvalidTokenError();
  }
  for (const ch of token) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      throw new InvalidTokenError();
    }
  }
}

function sleepFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
