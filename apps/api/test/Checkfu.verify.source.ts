// Test-only entry for Verify.model(Checkfu): @alchemy.run/domain's Source.ts
// currently populates `module.resolved` only for relative specifiers (not bare
// workspace package imports), so this file anchors Checkfu.model.ts and the
// three workspace domain models via relative paths without modifying production code.
import "../src/Checkfu.model.ts"
import "../../../packages/agents/src/Agents.model.ts"
import "../../../packages/environments/src/Environments.model.ts"
import "../../../packages/sessions/src/Sessions.model.ts"
