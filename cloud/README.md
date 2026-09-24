# Sync reliability and validation

## Conditional writes

`cloud/src/writeCoordinator.ts` routes protocol writes through the `VAULT_WRITER`
Durable Object binding, named by the normalized document path. The object's shared
store instances serialize the entire version check → history → R2 → D1 operation.
The HTTP API, MCP, nightly/reaction writes that use `putFile`/`deleteFile`, and R2
event reconciliation use this boundary. Different document paths can progress in parallel.

`cloud/wrangler.toml` includes the `v1-vault-writer` SQLite Durable Object migration.
Deploy that configuration with the Worker; production protocol writes fail closed if
the binding is absent. No D1 schema change is needed for this coordination change.

This prevents concurrent conditional saves from both succeeding. It is not a
distributed transaction between R2 and D1: interruption between blob and metadata
publication still requires reconciliation. Direct S3/R2 writers bypass API preconditions;
their queue events reconcile the latest object under the same coordinator.
See [Cloudflare's Durable Object invocation documentation](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/).

## Browser caches

`src/web/remoteVault.ts` verifies OAuth identity before loading a persistent mirror.
Cache names contain version `v2`, encoded server URL, and `user:<sub>` or `service`.
Legacy host-only mirrors are never read. Private rows from an injected/old backend
are filtered before reaching the UI. If identity verification fails, loading stops
and can be retried; a new OAuth boot needs the server to verify identity.

`RemoteCache.flush()` builds each delta inside its write queue. Failed writes put
their paths back in the dirty set, so the next flush/poll retries those rows/deletions
before committing a newer cursor. Reset waits for queued writes before clearing state.

## Reproducible checks

```sh
npm run test:all
npm run build:web
npm run typecheck --prefix cloud
node scripts/check-remote-mcp.mjs --from-claude
```

The final command reads the existing `strata` connection for the current project in
`~/.claude.json`. Alternatively set `STRATA_MCP_URL`, `STRATA_TEAM_TOKEN`, and optionally
`STRATA_TEST_QUERY` (default `소음`). It checks MCP tool discovery, listing, topic search,
reading a result and recall with sources. It does not modify the vault or send messages.

`cloud/test/searchRegression.test.ts` always runs a small deterministic Korean corpus
in CI, checking topic ranking, linked recall evidence, privacy and deleted documents.
The four legacy frontend search suites still require their original game-design corpus
via `STRATA_TEST_VAULT`; a different live vault cannot satisfy those document-specific
expectations. The remote MCP check validates the current vault separately.
