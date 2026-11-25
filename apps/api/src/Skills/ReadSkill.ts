import type { SkillReading } from "./SkillReader.ts"

export const readSkill = async (markdown: string): Promise<SkillReading> => {
	const { isModelInvocable, parseSkill } = await import("agents/skills")
	const parsed = parseSkill(markdown)
	const problem = parsed.ok ? parsed.warnings[0] : parsed.error
	if (!parsed.ok || problem !== undefined) {
		return { ok: false, message: problem?.message ?? "its SKILL.md cannot be read" }
	}
	if (!isModelInvocable(parsed.value)) {
		return {
			ok: false,
			message:
				"it sets disable-model-invocation, and a session has no way to invoke a skill other than the model's",
		}
	}
	return { ok: true, name: parsed.value.name, description: parsed.value.description }
}
