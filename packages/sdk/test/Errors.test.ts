import { describe, expect, it } from "@effect/vitest"
import {
	AuthenticationError,
	BadRequestError,
	ConflictError,
	InternalServerError,
	NotFoundError,
	PayloadTooLargeError,
	PermissionDeniedError,
	RateLimitError,
	ServiceUnavailableError,
	UnexpectedStatusError,
	UnprocessableEntityError,
	UnsupportedMediaTypeError,
	isAPIError,
	isCheckfuError,
} from "../src/Errors.ts"

describe("errors for a non-2xx response", () => {
	const fields = { message: "m", requestId: "req_1", body: "raw body" }

	it("says which statuses may succeed later, and exposes the request id and body", () => {
		const errors = [
			[new BadRequestError({ ...fields, status: 400 }), false],
			[new AuthenticationError({ ...fields, status: 401 }), false],
			[new PermissionDeniedError({ ...fields, status: 403 }), false],
			[new NotFoundError({ ...fields, status: 404 }), false],
			[new ConflictError({ ...fields, status: 409 }), false],
			[new PayloadTooLargeError({ ...fields, status: 413 }), false],
			[new UnsupportedMediaTypeError({ ...fields, status: 415 }), false],
			[new UnprocessableEntityError({ ...fields, status: 422 }), false],
			[new RateLimitError({ ...fields, status: 429 }), true],
			[new InternalServerError({ ...fields, status: 500 }), true],
			[new InternalServerError({ ...fields, status: 504 }), true],
			[new ServiceUnavailableError({ ...fields, status: 503 }), true],
			[new UnexpectedStatusError({ ...fields, status: 408 }), true],
			[new UnexpectedStatusError({ ...fields, status: 418 }), false],
		] as const
		for (const [error, retryable] of errors) {
			expect([error._tag, error.status, error.retryable]).toEqual([
				error._tag,
				error.status,
				retryable,
			])
			expect(error.requestID).toBe("req_1")
			expect(error.error).toBe("raw body")
			expect(error.name).toBe(error._tag)
			expect(String(error)).toBe(`${error._tag}: m`)
			expect(isAPIError(error) && isCheckfuError(error)).toBe(true)
		}
		expect(new Set(errors.map(([error]) => error.constructor)).size).toBe(12)
		expect(new NotFoundError({ ...fields, status: 404 })).not.toBeInstanceOf(BadRequestError)
	})
})
