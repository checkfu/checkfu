import * as Cloudflare from "@alchemy.run/cloudflare"
import type { ApiCatalog } from "../OpenApi/ApiCatalog.ts"
import type { Connection } from "./Connection.ts"

/**
 * Hosts the objects that send to third-party servers. Its own Worker, without
 * traces: Workers Traces record an outbound request's full URL, and an API key
 * can be sent in the query.
 */
export class ConnectionWorker extends Cloudflare.Worker<
	ConnectionWorker,
	Record<never, never>,
	Connection | ApiCatalog
>()("ConnectionWorker") {}
