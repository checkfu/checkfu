import { parseProviderBaseUrl } from "@checkfu/pi-providers/fetch"
import { isPublicIpAddress } from "@checkfu/sdk/WebhookUrl"
import { expect, it } from "vitest"

it.each([
	"10.0.0.1",
	"127.0.0.1",
	"169.254.1.1",
	"100.64.0.1",
	"172.16.0.1",
	"192.168.1.1",
	"[::1]",
	"[fc00::1]",
	"[fe80::1]",
])("blocks %s in both webhook and provider configuration", (host) => {
	expect(isPublicIpAddress(host)).toBe(false)
	expect(() => parseProviderBaseUrl(`https://${host}`, { allowLoopbackHttp: false })).toThrow(
		"Refusing private or loopback host",
	)
})
