// `cloudflare:workers` exists only inside the Workers runtime. @cloudflare/workers-oauth-provider
// imports WorkerEntrypoint from it at module load, so the Node test runner needs this stand-in.
export class WorkerEntrypoint {}
