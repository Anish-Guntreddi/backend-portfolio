# @portfolio/flagforge-sdk

Client SDK for FlagForge. Bootstraps flag definitions from the server once, then evaluates locally
using the same `evaluate()` engine as the server — guaranteeing byte-identical decisions with zero
per-evaluation network latency.

## Usage

```ts
import { createClient } from '@portfolio/flagforge-sdk';

const client = createClient({
  baseUrl: 'https://your-flagforge-server.example.com',
  apiKey: 'your-api-key',
  pollIntervalMs: 30_000,         // optional: refresh flags every 30 s
});

await client.bootstrap();         // fetch flag definitions once

const show = client.variation('show-banner', { key: userId }, false);
```

## API

### `createClient(options)`

| Option | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | yes | Root URL of the FlagForge server |
| `apiKey` | `string` | yes | API key sent as `x-api-key` header |
| `pollIntervalMs` | `number` | no | Background poll interval in ms. Default: off |
| `fetch` | `typeof fetch` | no | Injectable fetch for tests. Default: `globalThis.fetch` |
| `onError` | `(err) => void` | no | Called when a background poll fails |

### `client.bootstrap(): Promise<void>`

Fetches all flag definitions from `GET /flags` and caches them. Starts background polling if
`pollIntervalMs` is set. Rejects on a non-2xx response.

### `client.variation(flagKey, context, defaultValue): T`

Synchronous local evaluation. Returns `defaultValue` if the flag is not loaded.

### `client.evaluateDetail(flagKey, context, defaultValue): EvalDetail`

Like `variation` but returns `{ value, variation, reason }`. Reason is `{ kind: 'FLAG_NOT_FOUND' }`
when the flag isn't cached.

### `client.allFlags(context): Record<string, JsonValue>`

Evaluate every loaded flag for the given context and return a key→value map.

### `client.evaluateRemote(flagKey, context, defaultValue): Promise<RemoteEvalResult>`

Call `POST /evaluate` for a server-authoritative result. Falls back to
`{ value: defaultValue, reason: { kind: 'ERROR' } }` on network failure.

### `client.close(): void`

Stop the background poll timer.
