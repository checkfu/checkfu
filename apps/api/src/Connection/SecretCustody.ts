export const UNCONFIRMED_SECRET_TTL_MS = 24 * 60 * 60 * 1000

const SECRET = "secret"
const STATUS = "status"

type CustodyStatus = "unconfirmed" | "kept" | "erased"

export interface CustodyStorage {
	readonly get: (key: string) => string | undefined
	readonly put: (key: string, value: string) => void
	readonly clear: () => Promise<void>
	readonly setAlarm: (at: number) => Promise<void>
	readonly deleteAlarm: () => Promise<void>
}

/**
 * Custody of one credential's secret. A secret arrives before the credential
 * is known to exist, so it is held unconfirmed and erases itself unless the
 * credential's creation confirms it. A confirmed secret that is erased is
 * never held again.
 */
export const makeSecretCustody = (storage: CustodyStorage, now: () => number) => {
	const status = (): CustodyStatus | undefined => {
		const stored = storage.get(STATUS)
		return stored === "unconfirmed" || stored === "kept" || stored === "erased" ? stored : undefined
	}
	const erase = async (): Promise<void> => {
		const confirmed = status() !== "unconfirmed"
		await storage.clear()
		await storage.deleteAlarm()
		if (confirmed) {
			storage.put(STATUS, "erased")
		}
	}
	return {
		store: async (secret: string): Promise<boolean> => {
			const current = status()
			if (current === "kept" || current === "erased") {
				return false
			}
			storage.put(SECRET, secret)
			storage.put(STATUS, "unconfirmed")
			await storage.setAlarm(now() + UNCONFIRMED_SECRET_TTL_MS)
			return true
		},
		replace: (secret: string): boolean => {
			const current = status()
			if (current !== "kept" && current !== "unconfirmed") {
				return false
			}
			storage.put(SECRET, secret)
			return true
		},
		keep: async (): Promise<void> => {
			if (status() === "unconfirmed") {
				storage.put(STATUS, "kept")
				await storage.deleteAlarm()
			}
		},
		erase,
		read: (): string | null => {
			const current = status()
			return current === "kept" || current === "unconfirmed" ? (storage.get(SECRET) ?? null) : null
		},
		expire: async (): Promise<void> => {
			if (status() === "unconfirmed") {
				await erase()
			}
		},
	}
}

export type SecretCustody = ReturnType<typeof makeSecretCustody>
