import { describe, expect, it } from "@effect/vitest"
import { formatApiErrorEnvelope } from "../src/Errors.ts"

describe("formatApiErrorEnvelope", () => {
	it("appends the request id when present", () => {
		const failure = formatApiErrorEnvelope({
			type: "error",
			error: { type: "internal_error", message: "Internal server error." },
			request_id: "req_0123456789abcdef01234567",
		})
		expect(failure.message).toBe(
			"API error (500 internal_error): Internal server error. [request_id: req_0123456789abcdef01234567]",
		)
	})

	it("omits the suffix when request_id is absent", () => {
		const failure = formatApiErrorEnvelope({
			type: "error",
			error: { type: "internal_error", message: "Internal server error." },
		})
		expect(failure.message).toBe("API error (500 internal_error): Internal server error.")
	})

	it("places the request id after batch error details", () => {
		const failure = formatApiErrorEnvelope({
			type: "error",
			error: { type: "conflict_error", message: "Conflict." },
			accepted: [{}],
			failed_index: 1,
			request_id: "req_abc",
		})
		expect(failure.message).toBe(
			"API error (409 conflict_error): Conflict. (1 event(s) accepted, failed_index=1) [request_id: req_abc]",
		)
	})

	it("prefers observedStatus while keeping the request id suffix", () => {
		const failure = formatApiErrorEnvelope(
			{
				type: "error",
				error: { type: "internal_error", message: "Bad gateway." },
				request_id: "req_502",
			},
			502,
		)
		expect(failure.message).toBe(
			"API error (502 internal_error): Bad gateway. [request_id: req_502]",
		)
	})

	it("omits unsafe or oversized request ids", () => {
		const unsafeIds = ["", "req with space", "req_\u001b[31m", "req_\nnext", "a".repeat(129)]
		for (const requestId of unsafeIds) {
			const failure = formatApiErrorEnvelope({
				type: "error",
				error: { type: "internal_error", message: "Internal server error." },
				request_id: requestId,
			})
			expect(failure.message).not.toContain("[request_id:")
		}
	})

	it("keeps exitCode set to 1", () => {
		const failure = formatApiErrorEnvelope({
			type: "error",
			error: { type: "internal_error", message: "Internal server error." },
			request_id: "req_123",
		})
		expect(failure.exitCode).toBe(1)
	})
})
