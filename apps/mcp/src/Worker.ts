import * as Context from "effect/Context"
import { ApiBinding } from "./GeneratedRuntime.ts"
import { makeMcpWebHandler } from "./Server.ts"

interface Env {
	readonly API: { readonly fetch: typeof globalThis.fetch }
}

const mcp = makeMcpWebHandler()

export default {
	fetch: (request: Request, env: Env): Promise<Response> =>
		mcp.handler(request, Context.make(ApiBinding, env.API)),
}
