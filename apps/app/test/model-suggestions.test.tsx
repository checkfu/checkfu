// @vitest-environment happy-dom
import { fireEvent, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { ModelField } from "../src/model-field.tsx"
import { button, click, mount, stubApi, type } from "./dom.tsx"

function Editor({ initial = "" }: { readonly initial?: string }) {
	const [model, setModel] = useState(initial)
	return <ModelField value={model} onChange={(event) => setModel(event.target.value)} />
}

afterEach(() => vi.unstubAllGlobals())

it("preserves manual entry and offers more authenticated model suggestions", async () => {
	const sent = stubApi(({ path }) => {
		const { searchParams } = new URL(path, "http://dashboard.test")
		const key = searchParams.get("search")
		if (key === "lab/unlisted") {
			return { body: { data: [], next_page: null } }
		}
		const second = searchParams.get("page") === "more"
		return {
			body: {
				data: [{ type: "model", id: second ? "studio/report" : "lab/report" }],
				next_page: second ? null : "more",
			},
		}
	})
	const page = await mount(<Editor />)
	try {
		const input = page.container.querySelector("input")
		if (input === null) {
			throw new Error("Missing editable model input.")
		}
		expect(sent).toHaveLength(0)
		fireEvent.focusIn(input)
		await waitFor(() =>
			expect(page.container.querySelector('option[value="lab/report"]')).not.toBeNull(),
		)
		await click(button(page.container, "Load more models"))
		await waitFor(() =>
			expect(page.container.querySelector('option[value="studio/report"]')).not.toBeNull(),
		)
		await type(input, "lab/unlisted")
		await waitFor(() => expect(sent.at(-1)?.path).toBe("/v1/models?search=lab%2Funlisted"))
		expect(input.value).toBe("lab/unlisted")
		expect(page.container.querySelector("option")).toBeNull()
	} finally {
		page.unmount()
	}
})

it("keeps the saved model editable if suggestions fail", async () => {
	stubApi(() => ({ status: 503, body: { error: { message: "Unavailable." } } }))
	const page = await mount(<Editor initial="fixture/old-model" />)
	try {
		const input = page.container.querySelector("input")
		if (input === null) {
			throw new Error("Missing editable model input.")
		}
		fireEvent.focusIn(input)
		await waitFor(() =>
			expect(page.container.textContent).toContain("Could not load model suggestions."),
		)
		expect(input.value).toBe("fixture/old-model")
		await type(input, "fixture/new-model")
		expect(input.value).toBe("fixture/new-model")
	} finally {
		page.unmount()
	}
})
