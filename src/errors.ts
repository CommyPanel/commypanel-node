import type { Deployment } from "./types.js";

/** The base of every error this library throws on purpose. */
export class CommyPanelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An error answer from the panel. `message` is the panel's own sentence. */
export class ApiError extends CommyPanelError {
  /** The HTTP status code. */
  readonly status: number;
  /** The problems of a 422, by field name. */
  readonly fields: Record<string, string[]>;
  /** The deployment that is already running, on a 409 that says so. */
  readonly deployment: Deployment | null;
  /** How long the panel asked to wait, when it did (429). */
  readonly retryAfterSeconds: number;

  constructor(
    status: number,
    message: string,
    fields: Record<string, string[]> = {},
    deployment: Deployment | null = null,
    retryAfterSeconds = 0,
  ) {
    super(describe(status, message, fields));
    this.status = status;
    this.fields = fields;
    this.deployment = deployment;
    this.retryAfterSeconds = retryAfterSeconds;
    this.panelMessage = message;
  }

  /** The panel's sentence alone, without the status and field details that `message` adds. */
  readonly panelMessage: string;
}

function describe(status: number, message: string, fields: Record<string, string[]>): string {
  let text = `commypanel: ${status} ${message}`;
  for (const name of Object.keys(fields).sort()) {
    text += ` (${name}: ${(fields[name] ?? []).join(" ")})`;
  }
  return text;
}

/** The panel address is not https (or loopback http, when allowed). */
export class InsecureUrlError extends CommyPanelError {
  constructor() {
    super("commypanel: the panel address must be https");
  }
}

/** The panel address is not a plain scheme://host[:port]. */
export class InvalidUrlError extends CommyPanelError {
  constructor() {
    super("commypanel: the panel address must look like https://panel.example.com");
  }
}

/** The token is empty or has spaces or control characters. */
export class InvalidTokenError extends CommyPanelError {
  constructor() {
    super("commypanel: the token is empty or has characters a token cannot have");
  }
}

/** An app name or variable name that cannot be valid; no request was made. */
export class InvalidInputError extends CommyPanelError {
  constructor() {
    super("commypanel: invalid app or variable name");
  }
}

/** An option has a value the client refuses. */
export class InvalidOptionError extends CommyPanelError {}

/** An answer is bigger than the client accepts. */
export class ResponseTooLargeError extends CommyPanelError {
  constructor() {
    super("commypanel: the answer is too large");
  }
}

/** The panel answered with a redirect. Redirects are never followed, so a token cannot be handed to another host. */
export class RedirectError extends CommyPanelError {
  constructor() {
    super("commypanel: the panel answered with a redirect, which is not followed (check the address, https and www)");
  }
}

/** The answer was not the JSON the API gives. The body is deliberately not repeated. */
export class UnexpectedResponseError extends CommyPanelError {}

/** The connection failed (DNS, refused, reset, TLS). The message never holds the token. */
export class TransportError extends CommyPanelError {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** The caller's AbortSignal fired. */
export class AbortError extends CommyPanelError {
  constructor() {
    super("commypanel: the call was cancelled");
  }
}

/** The request took longer than the timeout. */
export class TimeoutError extends CommyPanelError {
  constructor() {
    super("commypanel: the request timed out");
  }
}

function hasStatus(err: unknown, status: number): boolean {
  return err instanceof ApiError && err.status === status;
}

/** A 404: no such app, deployment or variable, or an app the token may not use. */
export const isNotFound = (err: unknown): boolean => hasStatus(err, 404);
/** A 401: no token, or an invalid, revoked or expired one. */
export const isUnauthorized = (err: unknown): boolean => hasStatus(err, 401);
/** A 403: the token lacks the ability, or its owner lacks the permission. */
export const isForbidden = (err: unknown): boolean => hasStatus(err, 403);
/** A 409: the state does not allow it, for example a deployment is already running (see `ApiError.deployment`). */
export const isConflict = (err: unknown): boolean => hasStatus(err, 409);
/** A 429. */
export const isRateLimited = (err: unknown): boolean => hasStatus(err, 429);
