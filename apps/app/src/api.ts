import { Checkfu } from "@checkfu/sdk/client"
import { isCheckfuError } from "@checkfu/sdk/Errors"

export const checkfu = new Checkfu({
	baseUrl: window.location.origin,
	apiKey: "held-by-the-app-worker",
	maxRetries: 2,
})

export const errorMessage = (error: unknown): string =>
	isCheckfuError(error) ? error.message : "Something went wrong."

export const isSignedOut = (error: unknown): boolean =>
	isCheckfuError(error) && error._tag === "AuthenticationError"

let verified = false

export const signedIn = async (): Promise<boolean> => {
	if (verified) {
		return true
	}
	const response = await fetch("/auth/session")
	verified = response.ok
	return verified
}

export const signIn = async (key: string): Promise<"ok" | "rejected" | "failed"> => {
	const response = await fetch("/auth/sign-in", {
		method: "POST",
		body: new URLSearchParams({ key }),
	})
	if (response.ok) {
		verified = true
	}
	return response.ok ? "ok" : response.status === 401 ? "rejected" : "failed"
}

export const signOut = async (): Promise<void> => {
	verified = false
	await fetch("/auth/sign-out", { method: "POST" })
}
