import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	ArchiveEnvironment,
	EnvironmentArchived,
} from "../src/Environment/ArchiveEnvironment.command.ts"
import {
	CreateEnvironment,
	EnvironmentAlreadyExists,
	EnvironmentCreated,
} from "../src/Environment/CreateEnvironment.command.ts"
import {
	DeleteEnvironment,
	EnvironmentDeleted,
} from "../src/Environment/DeleteEnvironment.command.ts"
import { Environment } from "../src/Environment/Environment.aggregate.ts"
import { EnvironmentArchivedError } from "../src/Environment/EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "../src/Environment/EnvironmentNotFound.rejection.ts"
import { EnvironmentView } from "../src/Environment/EnvironmentView.view.ts"
import {
	EnvironmentUpdated,
	EnvironmentVersionConflict,
	UpdateEnvironment,
} from "../src/Environment/UpdateEnvironment.command.ts"
import { Environments } from "../src/Environments.model.ts"

const story = Story.make(Environments)

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
const t1 = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")
const t2 = DateTime.makeUnsafe("2026-01-01T00:10:00.000Z")

const unrestrictedConfig = {
	type: "cloud" as const,
	networking: { type: "unrestricted" as const },
}

const limitedConfig = {
	type: "cloud" as const,
	networking: {
		type: "limited" as const,
		allow_mcp_servers: false,
		allow_package_managers: true,
		allowed_hosts: ["api.openai.com"],
	},
}

describe("Environments", () => {
	it.effect("is well defined", () =>
		Effect.scoped(Layer.build(Environments.layer(Layer.empty))).pipe(
			Effect.provide(Domain.InMemory),
		),
	)

	it.effect("creates and updates an environment and projects EnvironmentView", () => {
		const env = Environment.ref("env_001")
		return story(
			Story.clock(t0),
			Story.when(
				new CreateEnvironment({
					environment_id: env.id,
					name: "Default Cloud",
					description: "Unrestricted sandbox",
					config: unrestrictedConfig,
				}),
			),
			Story.then(
				env,
				new EnvironmentCreated({
					version: 1,
					name: "Default Cloud",
					description: "Unrestricted sandbox",
					config: unrestrictedConfig,
				}),
			),
			Story.replied({ version: 1 }),
			Story.state(env, {
				status: "active",
				version: 1,
				name: "Default Cloud",
			}),
			Story.view(EnvironmentView, env, {
				id: env.id,
				type: "environment",
				version: 1,
				name: "Default Cloud",
				description: "Unrestricted sandbox",
				config: unrestrictedConfig,
				created_at: t0,
				updated_at: t0,
				archived_at: null,
			}),
			Story.clock(t1),
			Story.when(
				new UpdateEnvironment({
					environment_id: env.id,
					expected_version: 1,
					name: "Locked Down Cloud",
					description: "Limited egress",
					config: limitedConfig,
				}),
			),
			Story.then(
				env,
				new EnvironmentUpdated({
					version: 2,
					name: "Locked Down Cloud",
					description: "Limited egress",
					config: limitedConfig,
				}),
			),
			Story.replied({ version: 2 }),
			Story.state(env, {
				status: "active",
				version: 2,
				name: "Locked Down Cloud",
			}),
			Story.view(EnvironmentView, env, {
				id: env.id,
				type: "environment",
				version: 2,
				name: "Locked Down Cloud",
				description: "Limited egress",
				config: limitedConfig,
				created_at: t0,
				updated_at: t1,
				archived_at: null,
			}),
		)
	})

	it.effect("enforces optimistic concurrency, idempotent archive, and permanent deletion", () => {
		const missing = Environment.ref("env_missing")
		const env = Environment.ref("env_002")
		return story(
			Story.clock(t0),
			Story.when(
				new UpdateEnvironment({
					environment_id: missing.id,
					expected_version: 1,
					name: "Missing",
					description: null,
					config: unrestrictedConfig,
				}),
			),
			Story.rejected(new EnvironmentNotFound({ environment_id: missing.id })),
			Story.when(new ArchiveEnvironment({ environment_id: missing.id })),
			Story.rejected(new EnvironmentNotFound({ environment_id: missing.id })),
			Story.when(new DeleteEnvironment({ environment_id: missing.id })),
			Story.rejected(new EnvironmentNotFound({ environment_id: missing.id })),
			Story.when(
				new CreateEnvironment({
					environment_id: env.id,
					name: "Sandbox",
					description: null,
					config: unrestrictedConfig,
				}),
			),
			Story.then(
				env,
				new EnvironmentCreated({
					version: 1,
					name: "Sandbox",
					description: null,
					config: unrestrictedConfig,
				}),
			),
			Story.replied({ version: 1 }),
			Story.when(
				new CreateEnvironment({
					environment_id: env.id,
					name: "Duplicate",
					description: null,
					config: unrestrictedConfig,
				}),
			),
			Story.rejected(new EnvironmentAlreadyExists({ environment_id: env.id })),
			Story.when(
				new UpdateEnvironment({
					environment_id: env.id,
					expected_version: 2,
					name: "Stale",
					description: null,
					config: limitedConfig,
				}),
			),
			Story.rejected(
				new EnvironmentVersionConflict({
					environment_id: env.id,
					expected_version: 2,
					current_version: 1,
				}),
			),
			Story.clock(t1),
			Story.when(new ArchiveEnvironment({ environment_id: env.id })),
			Story.then(env, new EnvironmentArchived()),
			Story.state(env, { status: "archived", version: 1, name: "Sandbox" }),
			Story.when(new ArchiveEnvironment({ environment_id: env.id })),
			Story.then(env),
			Story.when(
				new UpdateEnvironment({
					environment_id: env.id,
					expected_version: 1,
					name: "After Archive",
					description: null,
					config: limitedConfig,
				}),
			),
			Story.rejected(new EnvironmentArchivedError({ environment_id: env.id })),
			Story.view(EnvironmentView, env, {
				id: env.id,
				type: "environment",
				version: 1,
				name: "Sandbox",
				description: null,
				config: unrestrictedConfig,
				created_at: t0,
				updated_at: t1,
				archived_at: t1,
			}),
			Story.clock(t2),
			Story.when(new DeleteEnvironment({ environment_id: env.id })),
			Story.then(env, new EnvironmentDeleted()),
			Story.state(env, { status: "deleted", version: 1, name: "Sandbox" }),
			Story.view(EnvironmentView, env, Story.none),
			Story.when(new DeleteEnvironment({ environment_id: env.id })),
			Story.rejected(new EnvironmentNotFound({ environment_id: env.id })),
			Story.when(new ArchiveEnvironment({ environment_id: env.id })),
			Story.rejected(new EnvironmentNotFound({ environment_id: env.id })),
			Story.when(
				new CreateEnvironment({
					environment_id: env.id,
					name: "Resurrected",
					description: null,
					config: unrestrictedConfig,
				}),
			),
			Story.rejected(new EnvironmentAlreadyExists({ environment_id: env.id })),
		)
	})
})
