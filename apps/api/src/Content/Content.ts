import * as Cloudflare from "@alchemy.run/cloudflare"
import { Random } from "alchemy/Random"

export type ContentShape = Record<never, never>

export class ContentWorker extends Cloudflare.Worker<ContentWorker, ContentShape>()(
	"ContentWorker",
) {}

export const ArtifactLinkSecret = Random("ArtifactLinkSecret")
