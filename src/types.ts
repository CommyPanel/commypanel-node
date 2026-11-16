/**
 * The objects the API returns, exactly as the API names them (snake_case, as in docs/openapi.yaml). Times are
 * ISO 8601 strings. None of them holds a secret.
 */

/** What a token may do. */
export const Ability = {
  Read: "apps:read",
  Deploy: "apps:deploy",
  Control: "apps:control",
  Logs: "apps:logs",
  Env: "apps:env",
} as const;
export type Ability = (typeof Ability)[keyof typeof Ability];

/** How a new release replaces the running one. */
export const DeployStrategy = {
  /** The new version starts beside the old one (no downtime). */
  Rolling: "rolling",
  /** The old version stops first, for software that cannot run twice on the same data. */
  StopFirst: "stop_first",
} as const;
export type DeployStrategy = (typeof DeployStrategy)[keyof typeof DeployStrategy];

/** The token the client is using. */
export interface Token {
  name: string;
  abilities: Ability[];
  /** The apps the token is limited to; null means every app its owner may use. */
  apps: string[] | null;
  expires_at: string | null;
  last_used_at: string | null;
  /** The owner's name. */
  owner: string;
}

/** One deployment, rollback or "apply changes". */
export interface Deployment {
  number: number;
  status: string;
  stage: string | null;
  /** True once it is over, whatever the result. Poll until it is. */
  finished: boolean;
  /** Only meaningful once finished. A watched release can still be rolled back later (status "rolled_back"). */
  succeeded: boolean;
  commit: string | null;
  commit_message: string | null;
  strategy: DeployStrategy;
  is_rollback: boolean;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
  url: string;
  /** The build log, only when asked for. */
  log?: string;
}

/** One app. */
export interface App {
  slug: string;
  name: string;
  status: string;
  stack: string | null;
  deploy_strategy: DeployStrategy;
  domains: string[];
  live_deployment: number | null;
  latest_deployment: Deployment | null;
  created_at: string;
}

/** The output of an app's running container. */
export interface Logs {
  /** False when the app has no running container. */
  live: boolean;
  lines: number;
  logs: string;
}

/** The names of an app's environment variables. Values are never returned by the API. */
export interface EnvKeys {
  keys: string[];
  /** True when variables, volumes or links changed after the running container was made: call applyChanges. */
  pending_changes: boolean;
}

/** The answer to setting or removing a variable. The value is not part of it. */
export interface EnvChange {
  key: string;
  pending_changes: boolean;
}

/** The result of {@link Client.setEnv}. */
export interface SetEnvResult {
  change: EnvChange;
  /** True when the variable is new (201), false when it replaced an existing one (200). */
  created: boolean;
}

/** Options for {@link Client.listDeployments}. */
export interface ListDeploymentsOptions {
  /** How many; 0 or absent uses the panel's default (20). The panel allows at most 50. */
  limit?: number;
  signal?: AbortSignal;
}

/** Options for {@link Client.getDeployment}. */
export interface GetDeploymentOptions {
  /** Include the build log. */
  log?: boolean;
  signal?: AbortSignal;
}

/** Options for {@link Client.logs}. */
export interface LogsOptions {
  /** How many lines; the panel clamps to 10..5000, 0 or absent uses its default (200). */
  tail?: number;
  signal?: AbortSignal;
}

/** Options for {@link Client.waitForDeployment}. */
export interface WaitOptions {
  /** How often to look, in milliseconds (at least 1000; default 3000). */
  pollMs?: number;
  /** Called with every look. */
  onUpdate?: (deployment: Deployment) => void;
  signal?: AbortSignal;
}

/** Options accepted by every call. */
export interface CallOptions {
  signal?: AbortSignal;
}
