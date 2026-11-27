import { defineConfig } from "vitest/config"
import { verificationTags } from "./Verification.ts"

export default defineConfig({ test: { tags: verificationTags } })
