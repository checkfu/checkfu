import type * as Cloudflare from "@alchemy.run/cloudflare"

export const toD1Jurisdiction = (
	jurisdiction: "eu" | "fedramp" | "us",
): Cloudflare.D1.Jurisdiction => jurisdiction as Cloudflare.D1.Jurisdiction
