import { expect, it } from "vitest"
import { isPublicIpAddress } from "../src/WebhookUrl.ts"

it.each([
	"8.8.8.8",
	" [2606:4700:4700::1111] ",
	"2001:30::1",
	"::FFFF:8.8.8.8",
	"0:0:0:0:0:FFFF:808:808",
])("accepts public address %s", (address) => {
	expect(isPublicIpAddress(address)).toBe(true)
})

it.each([
	"10.0.0.1",
	"127.0.0.1",
	"169.254.1.1",
	"100.64.0.1",
	"172.16.0.1",
	"192.168.1.1",
	"192.0.0.1",
	"192.0.2.1",
	"198.18.0.1",
	"198.51.100.1",
	"203.0.113.1",
	"224.0.0.1",
	"255.255.255.255",
	"0.0.0.0",
	"::1",
	"::",
	"fc00::1",
	"fd12::1",
	"fe80::1",
	"ff02::1",
	"2001::1",
	"2001:2::1",
	"2001:10::1",
	"2001:2f::1",
	"2001:db8::1",
	"2002::1",
	"::ffff:10.0.0.1",
	"::ffff:a00:1",
	"fe80::1%fixture",
	"2606:4700:4700::8.8.8.8",
	"0:0:0:0:0:ffff:8.8.8.8",
	"001.002.003.004",
	"::ffff:001.002.003.004",
	"not-an-ip",
	"",
])("refuses nonpublic or unsupported address %j", (address) => {
	expect(isPublicIpAddress(address)).toBe(false)
})
