import { describe, expect, it } from "vitest"
import { cn } from "../src/cn.ts"

describe("cn", () => {
	it("keeps a text color beside the kit's own text sizes", () => {
		expect(cn("text-primary-foreground", "text-control")).toBe(
			"text-primary-foreground text-control",
		)
		expect(cn("text-destructive", "text-meta")).toBe("text-destructive text-meta")
	})

	it("lets a later text size replace an earlier one", () => {
		expect(cn("text-sm", "text-control")).toBe("text-control")
	})
})
