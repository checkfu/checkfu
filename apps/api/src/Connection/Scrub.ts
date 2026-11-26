import type * as Schema from "effect/Schema"

export const REDACTED = "[redacted]"

export const secretForms = (secret: string): ReadonlyArray<string> => {
	if (secret.length === 0) {
		return []
	}
	const json = JSON.stringify(secret).slice(1, -1)
	return [
		...new Set([
			secret,
			encodeURIComponent(secret),
			new URLSearchParams({ s: secret }).toString().slice(2),
			json,
			json.replaceAll("/", String.raw`\/`),
		]),
	].filter((form) => form.length > 0)
}

const isList = (input: Schema.Json): input is ReadonlyArray<Schema.Json> => Array.isArray(input)
const escaped = (input: string): string => JSON.stringify(input).slice(1, -1)

export const scrubValue = (
	secrets: ReadonlyArray<string>,
): ((input: Schema.Json) => Schema.Json) => {
	const forms = [...new Set(secrets.flatMap(secretForms))].toSorted((a, b) => b.length - a.length)
	const numbers = new Set(
		secrets.flatMap((secret) =>
			secret.trim().length > 0 && Number.isFinite(Number(secret)) ? [Number(secret)] : [],
		),
	)
	const holds = (input: string): boolean => forms.some((form) => input.includes(form))
	const exposes = (input: string): boolean => holds(input) || holds(escaped(input))
	const replaced = (input: string, mark: string): string => {
		let clean = input
		for (;;) {
			const next = forms.reduce((current, form) => current.replaceAll(form, mark), clean)
			if (next === clean) {
				return clean
			}
			clean = next
		}
	}
	const mark = [REDACTED, "*****", ""].find((candidate) => !exposes(candidate)) ?? ""
	const cut = (input: string): string => {
		let code = 0xe0_00
		const taken = (place: string) => input.includes(place) || forms.some((f) => f.includes(place))
		while (taken(String.fromCodePoint(code))) {
			code += 1
		}
		const place = String.fromCodePoint(code)
		return replaced(input, place).replaceAll(place, mark)
	}
	const text = (input: string): string => {
		let clean = input
		for (let pass = 0; pass < 4 && exposes(clean); pass += 1) {
			clean = cut(holds(clean) ? clean : escaped(clean))
		}
		return exposes(clean) ? mark : clean
	}
	const value = (input: Schema.Json): Schema.Json => {
		if (typeof input === "string") {
			return text(input)
		}
		if (typeof input === "boolean" || input === null) {
			return input
		}
		if (typeof input === "number") {
			if (!Number.isFinite(input)) {
				return null
			}
			if (numbers.has(input)) {
				return mark
			}
			const written = String(input)
			const clean = text(written)
			return clean === written ? input : clean
		}
		if (isList(input)) {
			return input.map(value)
		}
		return Object.fromEntries(Object.entries(input).map(([key, item]) => [text(key), value(item)]))
	}
	return (input) => {
		if (forms.length === 0) {
			return value(input)
		}
		const clean = value(input)
		return holds(JSON.stringify(clean)) ? (holds(JSON.stringify(mark)) ? null : mark) : clean
	}
}
