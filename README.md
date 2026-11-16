# commypanel (Node.js)

A small client for the HTTP API of a [CommyPanel](https://github.com/commypanel/panel) server: list apps, start
and follow deployments, start, stop and restart an app, read its logs and manage its environment variables.

- **No runtime dependencies.** Only Node's own `node:http` and `node:https`. Node 20 or newer.
- **TypeScript types included.** ESM only.
- **Hard to misuse.** https only, no redirects, bounded retries and answers, the token kept out of errors and
  logs. See [Security](#security).
- **Matches the API.** `testdata/openapi.yaml` is a copy of the panel's API description, and a test fails when
  the API gains a call this library does not have.

```bash
npm install commypanel
```

(The package is not published yet; until then install from this repository.)

## Use

Create a token in the panel under **Settings > API tokens**. Give it only what it needs (for a deploy job:
`apps:deploy` and `apps:read`), limit it to one app and let it expire.

```js
import { Client, isConflict } from "commypanel";

const client = new Client("https://panel.example.com", process.env.COMMY_TOKEN);

const queued = await client.startDeployment("shop");
const done = await client.waitForDeployment("shop", queued.number, {
  onUpdate: (d) => console.log(d.status),
});

if (!done.succeeded) {
  throw new Error(`the deployment ended as ${done.status}: ${done.error ?? ""}`);
}
```

Objects are returned **exactly as the API names them** (`snake_case`: `deploy_strategy`, `latest_deployment`,
`pending_changes`), and times are ISO 8601 strings. Every call takes an optional `{ signal }` (an
`AbortSignal`).

Errors from the panel are `ApiError`s with `status`, `panelMessage` (the panel's sentence), `fields` (a 422's
field problems), `deployment` (the one already running, on a 409 that says so) and `retryAfterSeconds`. Test
them with `isNotFound(err)`, `isForbidden`, `isConflict`, `isUnauthorized`, `isRateLimited`, or `instanceof`.
Everything this library throws on purpose extends `CommyPanelError`.

| Method | API call | Ability |
|---|---|---|
| `token()` | `GET /token` | none |
| `listApps()`, `getApp(slug)` | `GET /apps`, `GET /apps/{slug}` | `apps:read` |
| `listDeployments(slug, { limit })`, `getDeployment(slug, number, { log })` | `GET /apps/{slug}/deployments[/{n}]` | `apps:read` |
| `startDeployment(slug)`, `applyChanges(slug)` | `POST /apps/{slug}/deployments`, `/apply` | `apps:deploy` |
| `startApp(slug)`, `stopApp(slug)`, `restartApp(slug)` | `POST /apps/{slug}/start`, `/stop`, `/restart` | `apps:control` |
| `logs(slug, { tail })` | `GET /apps/{slug}/logs` | `apps:logs` |
| `listEnv(slug)`, `setEnv(slug, key, value)`, `unsetEnv(slug, key)` | `GET`, `PUT`, `DELETE /apps/{slug}/env[/{key}]` | `apps:env` |
| `waitForDeployment(slug, number, { pollMs, onUpdate, signal })` | polls `GET .../deployments/{n}` | `apps:read` |

Environment variable **values are write-only**: the API never returns them, so `listEnv` gives names.
`setEnv` resolves to `{ change, created }`.

## Security

- **https only.** `new Client()` refuses any other address. `allowHttpLoopback: true` allows plain http for
  `localhost`, `127.0.0.1` and `::1` only, for development.
- **TLS is always verified.** There is no option to skip it, and unknown options are never passed to the TLS
  layer. For a panel with a private CA, give `caCertPem` (added to the usual roots).
- **Redirects are never followed**, so the token cannot be handed to another address; a redirect is a
  `RedirectError`.
- **The token stays out of sight.** It is held in a private class field and sent only in the `Authorization`
  header: not in URLs, not in `toString()`, `JSON.stringify`, `console.log` or `util.inspect`, and it is
  scrubbed from transport errors and from error text the panel sends back.
- **Bounded.** A timeout (30 s), at most 2 retries (never for a write that may have happened: only after a
  429, and after 502/503/504 for reads), `Retry-After` capped at 30 s, answers capped at 16 MiB.
- **Names are checked before any request**, so an app or variable name cannot change the path.
- **No install scripts and no runtime dependencies**, so installing this package runs none of its code and
  pulls in nothing else.

Report a security problem privately, as described in [SECURITY.md](SECURITY.md).

## Compatibility

This library speaks API `v1` (`/api/v1`) of CommyPanel 0.10 and later. It needs Node 20 or newer.

## Development

```bash
npm ci
npm test                                   # builds with tsc, then runs the tests (node:test)
scripts/sync-spec.sh ../../commypanel      # copy the API description from the panel repository
```

`testdata/tls` holds throwaway, test-only certificates for the TLS tests.

## Publishing

Not done from a laptop. When the time comes, publishing to npm happens from CI with provenance
(`npm publish --provenance`), as a deliberate, reviewed step. There is no publish workflow yet.

MIT licensed.
