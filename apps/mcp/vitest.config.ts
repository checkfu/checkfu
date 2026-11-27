import { defineConfig } from "vitest/config"
import { verificationTags } from "../../tools/release/Verification.ts"

export default defineConfig({ test: { tags: verificationTags } })
