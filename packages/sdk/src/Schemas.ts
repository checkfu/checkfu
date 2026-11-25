import * as Schema from "effect/Schema"

export const MAX_AGENT_NAME_LENGTH = 256
export const MAX_AGENT_DESCRIPTION_LENGTH = 2048
export const MAX_AGENT_SYSTEM_LENGTH = 100_000

export const MAX_ENVIRONMENT_NAME_LENGTH = 256
export const MAX_ENVIRONMENT_DESCRIPTION_LENGTH = 1024

export const MAX_AUTOMATION_ID_LENGTH = 128
export const MAX_AUTOMATION_NAME_LENGTH = 256
export const MAX_AUTOMATION_DESCRIPTION_LENGTH = 2048
export const MAX_CRON_EXPRESSION_LENGTH = 256
export const MAX_TIMEZONE_LENGTH = 64

export const MAX_IDENTIFIER_LENGTH = 256
export const MAX_TITLE_LENGTH = 1024
export const MAX_MESSAGE_TEXT_LENGTH = 16_384
export const MAX_THINKING_TEXT_LENGTH = 16_384
export const MAX_ERROR_TYPE_LENGTH = 128
export const MAX_ERROR_MESSAGE_LENGTH = 4096

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

import { SINGLE_PATH_SEGMENT_MESSAGE } from "./PathSegment.ts"

export { SINGLE_PATH_SEGMENT_MESSAGE, isSinglePathSegment } from "./PathSegment.ts"

export const SinglePathSegmentCheck = Schema.isPattern(/^(?!\.\.?$)[^/\\]+$/, {
	message: SINGLE_PATH_SEGMENT_MESSAGE,
})

export const ResourceId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
)

export const ResourceListCursor = Schema.String.check(
	Schema.isPattern(/^\d{1,15}:[^/\\]+$/u),
).annotate({
	description:
		"Opaque cursor from a previous page's next_cursor; the page continues after it in the selected order",
})

export const AgentId = Schema.String.check(Schema.isMinLength(1), SinglePathSegmentCheck).pipe(
	Schema.brand("AgentId"),
)
export type AgentId = typeof AgentId.Type

export const AgentVersionId = Schema.String.check(
	Schema.isMinLength(1),
	SinglePathSegmentCheck,
).pipe(Schema.brand("AgentVersionId"))
export type AgentVersionId = typeof AgentVersionId.Type

export const EnvironmentId = Schema.String.check(
	Schema.isMinLength(1),
	SinglePathSegmentCheck,
).pipe(Schema.brand("EnvironmentId"))
export type EnvironmentId = typeof EnvironmentId.Type

export const SessionId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
	SinglePathSegmentCheck,
).pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const AutomationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_AUTOMATION_ID_LENGTH),
	SinglePathSegmentCheck,
).pipe(Schema.brand("AutomationId"))
export type AutomationId = typeof AutomationId.Type

export const AgentName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_AGENT_NAME_LENGTH),
)
export const AgentDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_AGENT_DESCRIPTION_LENGTH),
)
export const AgentSystem = Schema.String.check(Schema.isMaxCodePoints(MAX_AGENT_SYSTEM_LENGTH))

export const AgentModel = Schema.Struct({
	id: NonEmptyString,
})
export type AgentModel = typeof AgentModel.Type

export const AgentSnapshot = Schema.Struct({
	id: AgentId,
	type: Schema.Literal("agent"),
	version: PositiveInt,
	current_version_id: AgentVersionId,
	name: NonEmptyString,
	model: AgentModel,
	system: Schema.NullOr(Schema.String),
	description: Schema.NullOr(Schema.String),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type AgentSnapshot = typeof AgentSnapshot.Type

export const EnvironmentName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_ENVIRONMENT_NAME_LENGTH),
)
export const EnvironmentDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_ENVIRONMENT_DESCRIPTION_LENGTH),
)

export const EnvironmentNetworking = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("unrestricted"),
	}),
	Schema.Struct({
		type: Schema.Literal("limited"),
		allow_mcp_servers: Schema.Boolean,
		allow_package_managers: Schema.Boolean,
		allowed_hosts: Schema.Array(NonEmptyString),
	}),
])
export type EnvironmentNetworking = typeof EnvironmentNetworking.Type

export const EnvironmentConfig = Schema.Struct({
	type: Schema.Literal("cloud"),
	networking: EnvironmentNetworking,
})
export type EnvironmentConfig = typeof EnvironmentConfig.Type

export const EnvironmentSnapshot = Schema.Struct({
	id: EnvironmentId,
	type: Schema.Literal("environment"),
	version: PositiveInt,
	name: NonEmptyString,
	description: Schema.NullOr(Schema.String),
	config: EnvironmentConfig,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type EnvironmentSnapshot = typeof EnvironmentSnapshot.Type

export const SessionTitle = Schema.String.check(Schema.isMaxLength(MAX_TITLE_LENGTH))
export const MessageText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_MESSAGE_TEXT_LENGTH),
)
export const ThinkingText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_THINKING_TEXT_LENGTH),
)
export const ErrorType = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ERROR_TYPE_LENGTH),
)
export const ErrorMessage = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ERROR_MESSAGE_LENGTH),
)

export const TextBlock = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String,
})
export type TextBlock = typeof TextBlock.Type

export const TextBlocks = Schema.Array(TextBlock).check(Schema.isMinLength(1))
export type TextBlocks = typeof TextBlocks.Type

export const StopReason = Schema.Struct({
	type: Schema.Literals([
		"end_turn",
		"interrupted",
		"retries_exhausted",
		"budget_reached",
		"refusal",
	]),
})
export type StopReason = typeof StopReason.Type

export const RetryStatus = Schema.Struct({
	type: Schema.Literals(["retrying", "exhausted", "terminal"]),
})
export type RetryStatus = typeof RetryStatus.Type

export const SessionErrorBody = Schema.Struct({
	type: Schema.String,
	message: Schema.String,
	retry_status: RetryStatus,
})
export type SessionErrorBody = typeof SessionErrorBody.Type

export const ModelUsage = Schema.Struct({
	input_tokens: NonNegativeInt,
	output_tokens: NonNegativeInt,
})
export type ModelUsage = typeof ModelUsage.Type

export const SessionStatus = Schema.Literals(["idle", "running", "terminated"])
export type SessionStatus = typeof SessionStatus.Type

export const ToolRejection = Schema.Literals(["unavailable", "invalid_arguments", "blocked"])
export type ToolRejection = typeof ToolRejection.Type

export const SessionEventFields = {
	"user.message": {
		content: TextBlocks,
	},
	"user.interrupt": {},
	"session.status_running": {
		turn: PositiveInt,
	},
	"span.model_request_start": {
		model_request_start_id: NonEmptyString,
	},
	"agent.tool_use": {
		tool_use_id: ResourceId,
		name: ResourceId,
		input: Schema.JsonObject,
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"agent.tool_result": {
		tool_use_id: ResourceId,
		content: Schema.Array(TextBlock),
		is_error: Schema.Boolean,
		truncated: Schema.optionalKey(Schema.Literal(true)),
		rejected: Schema.optionalKey(ToolRejection),
	},
	"agent.thinking": {
		thinking: Schema.String,
	},
	"agent.message": {
		content: TextBlocks,
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"span.model_request_end": {
		model_request_start_id: NonEmptyString,
		model_usage: ModelUsage,
		is_error: Schema.NullOr(Schema.Boolean),
	},
	"session.status_idle": {
		stop_reason: StopReason,
		turn: PositiveInt,
	},
	"session.error": {
		error: SessionErrorBody,
	},
	"session.status_terminated": {},
	"session.archived": {},
} as const

export type SessionEventType = keyof typeof SessionEventFields

export const MAX_SESSION_REPOSITORIES = 8
export const MAX_MOUNT_PATH_LENGTH = 1024
export const MAX_BRANCH_NAME_LENGTH = 255
export const REPOSITORY_MOUNT_ROOT = "/workspace"

export const SessionResourceId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("SessionResourceId"))
export type SessionResourceId = typeof SessionResourceId.Type

const SEGMENT_CHAR = String.raw`[^/\\\u0000-\u001f\u007f-\u009f]`
const SEGMENT_START = String.raw`[^/\\.\u0000-\u001f\u007f-\u009f]`
const NAMED_SEGMENT = String.raw`(?:${SEGMENT_START}${SEGMENT_CHAR}*|\.${SEGMENT_START}${SEGMENT_CHAR}*|\.\.${SEGMENT_CHAR}+)`

export const ABSOLUTE_PATH = new RegExp(`^(?:/${NAMED_SEGMENT})+$`, "u")

export const MountPath = Schema.String.check(
	Schema.isMaxLength(MAX_MOUNT_PATH_LENGTH),
	Schema.isPattern(ABSOLUTE_PATH),
)

export const RepositoryMountPath = MountPath.check(
	Schema.isPattern(/^\/workspace\/\S+$/u, {
		expected: `a path inside ${REPOSITORY_MOUNT_ROOT}, without spaces or line breaks`,
	}),
)

const REPOSITORY_URL =
	/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/u

const isRepositoryName = (url: string): boolean => {
	const name = url.slice(url.lastIndexOf("/") + 1)
	return name !== "." && name !== ".." && !name.endsWith(".git")
}

export const RepositoryUrl = Schema.String.check(
	Schema.isMaxLength(MAX_MOUNT_PATH_LENGTH),
	Schema.isPattern(REPOSITORY_URL, {
		expected: "a repository URL of the form https://github.com/<owner>/<repository>",
	}),
	Schema.makeFilter(isRepositoryName, {
		expected: "a repository name without a trailing .git",
	}),
)

export const MAX_REPOSITORY_TOKEN_LENGTH = 4096

export const RepositoryTokenText = Schema.String.annotate({ format: "password" }).check(
	Schema.isMinLength(1, { toJsonSchema: () => ({ minLength: 1, "x-forge-sensitive": true }) }),
	Schema.isMaxLength(MAX_REPOSITORY_TOKEN_LENGTH),
)
export const RepositoryToken = Schema.Redacted(RepositoryTokenText)
export type RepositoryToken = typeof RepositoryToken.Type

const isBranchName = (name: string): boolean =>
	Array.from({ length: name.length }, (_, index) => name.charCodeAt(index)).every(
		(code) => code > 0x20 && code !== 0x7f && !"~^:?*[\\".includes(String.fromCharCode(code)),
	) &&
	!/\s/u.test(name) &&
	!name.includes("..") &&
	!name.includes("@{") &&
	name !== "@" &&
	!name.endsWith(".") &&
	name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))

export const RepositoryCheckout = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("branch"),
		name: Schema.String.check(
			Schema.isMinLength(1),
			Schema.isMaxLength(MAX_BRANCH_NAME_LENGTH),
			Schema.makeFilter(isBranchName, { expected: "a git branch name" }),
		),
	}),
	Schema.Struct({
		type: Schema.Literal("commit"),
		sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
	}),
])
export type RepositoryCheckout = typeof RepositoryCheckout.Type

export const GitHubRepositoryResource = Schema.Struct({
	id: SessionResourceId,
	type: Schema.Literal("github_repository"),
	url: RepositoryUrl,
	mount_path: RepositoryMountPath,
	checkout: Schema.NullOr(RepositoryCheckout),
})
export type GitHubRepositoryResource = typeof GitHubRepositoryResource.Type

export const SessionMount = GitHubRepositoryResource
export type SessionMount = typeof SessionMount.Type

export const mountsOverlap = (a: string, b: string): boolean =>
	a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

const haveDisjointMounts = (resources: ReadonlyArray<SessionMount>): boolean =>
	resources.every((resource, index) =>
		resources
			.slice(index + 1)
			.every((other) => !mountsOverlap(resource.mount_path, other.mount_path)),
	)

const haveDistinctIds = (resources: ReadonlyArray<SessionMount>): boolean =>
	new Set(resources.map((resource) => resource.id)).size === resources.length

const mountEachRepositoryOnce = (resources: ReadonlyArray<SessionMount>): boolean =>
	new Set(resources.map((resource) => resource.url.toLowerCase())).size === resources.length

export const SessionMounts = Schema.Array(SessionMount).check(
	Schema.isMaxLength(MAX_SESSION_REPOSITORIES),
	Schema.makeFilter(haveDistinctIds, { expected: "resources with distinct ids" }),
	Schema.makeFilter(mountEachRepositoryOnce, { expected: "each repository mounted once" }),
	Schema.makeFilter(haveDisjointMounts, {
		expected: "mount paths that are neither equal nor inside one another",
	}),
)
export type SessionMounts = typeof SessionMounts.Type

export const SessionSnapshot = Schema.Struct({
	id: SessionId,
	type: Schema.Literal("session"),
	status: SessionStatus,
	agent_id: Schema.String,
	agent_version: PositiveInt,
	environment_id: Schema.String,
	title: Schema.NullOr(Schema.String),
	resources: SessionMounts,
	turn: NonNegativeInt,
	usage: ModelUsage,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type SessionSnapshot = typeof SessionSnapshot.Type

export const AutomationName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_AUTOMATION_NAME_LENGTH),
)

export const AutomationDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_AUTOMATION_DESCRIPTION_LENGTH),
)

export const CronExpression = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_CRON_EXPRESSION_LENGTH),
)
export const Timezone = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_TIMEZONE_LENGTH),
)

export const AutomationSchedule = Schema.Struct({
	type: Schema.Literal("cron"),
	expression: CronExpression,
	timezone: Timezone,
})
export type AutomationSchedule = typeof AutomationSchedule.Type

export const AutomationTrigger = Schema.Literals(["schedule", "manual"])
export type AutomationTrigger = typeof AutomationTrigger.Type

export const AutomationRunError = Schema.Struct({
	type: Schema.String,
	message: Schema.String,
})
export type AutomationRunError = typeof AutomationRunError.Type

export const AutomationSnapshot = Schema.Struct({
	id: AutomationId,
	type: Schema.Literal("automation"),
	name: AutomationName,
	description: Schema.NullOr(AutomationDescription),
	agent_id: ResourceId,
	agent_version: Schema.NullOr(PositiveInt),
	environment_id: ResourceId,
	text: MessageText,
	schedule: AutomationSchedule,
	status: Schema.Literals(["active", "paused", "archived"]),
	pause_reason: Schema.NullOr(Schema.String),
	runs: NonNegativeInt,
	activation: NonNegativeInt,
	revision: PositiveInt,
	upcoming: Schema.Array(NonNegativeInt),
	last_run_at: Schema.NullOr(Schema.DateTimeUtc),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type AutomationSnapshot = typeof AutomationSnapshot.Type

export const MAX_ARTIFACT_NAME_LENGTH = 256
export const MAX_ARTIFACT_FILES = 64
export const MAX_ARTIFACT_FILE_BYTES = 1024 * 1024
export const MAX_ARTIFACT_TOTAL_BYTES = 4 * 1024 * 1024
export const MAX_ARTIFACT_PATH_LENGTH = 512
export const MAX_ARTIFACT_CONTENT_TYPE_LENGTH = 128

const JSON_ESCAPE_ALLOWANCE = 3
export const MAX_ARTIFACT_BODY_BYTES =
	MAX_ARTIFACT_TOTAL_BYTES * JSON_ESCAPE_ALLOWANCE +
	MAX_ARTIFACT_FILES * (MAX_ARTIFACT_PATH_LENGTH * 6 + 512) +
	16 * 1024

export const MIN_LINK_TTL_SECONDS = 60
export const DEFAULT_LINK_TTL_SECONDS = 60 * 60
export const MAX_LINK_TTL_SECONDS = 7 * 24 * 60 * 60

export const ArtifactId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("ArtifactId"),
)
export type ArtifactId = typeof ArtifactId.Type

export const PUBLICATION_TOKEN_LENGTH = 25

export const PublicationAddress = Schema.String.check(
	Schema.isPattern(/^a[0-9a-f]{1,32}-[0-9a-z]{25}$/u),
).pipe(Schema.brand("PublicationAddress"))
export type PublicationAddress = typeof PublicationAddress.Type

export const ArtifactName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_ARTIFACT_NAME_LENGTH),
)

const PATH_EXCLUDED = String.raw`/\\\u0000-\u001f\u007f-\u009f\u2028\u2029`
const PATH_SEGMENT = String.raw`(?:[^.${PATH_EXCLUDED}][^${PATH_EXCLUDED}]*|\.[^.${PATH_EXCLUDED}][^${PATH_EXCLUDED}]*|\.\.[^${PATH_EXCLUDED}]+)`
const ARTIFACT_PATH = new RegExp(String.raw`^${PATH_SEGMENT}(?:/${PATH_SEGMENT})*$`, "u")

export const ArtifactPath = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_ARTIFACT_PATH_LENGTH),
	Schema.makeFilter((path) => (path.isWellFormed() ? undefined : "Expected well-formed Unicode")),
	Schema.isPattern(ARTIFACT_PATH),
)
export type ArtifactPath = typeof ArtifactPath.Type

export const ArtifactContentType = Schema.String.check(
	Schema.isMinCodePoints(3),
	Schema.isMaxCodePoints(MAX_ARTIFACT_CONTENT_TYPE_LENGTH),
	Schema.isPattern(
		/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:; ?[ -~]+)?$/u,
	),
)

export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))

export const ArtifactFileInput = Schema.Struct({
	path: ArtifactPath.annotate({
		description: "Relative path inside the artifact, for example index.html or assets/app.js",
	}),
	content: Schema.String.annotate({
		description: "File content: text, or base64 when encoding is base64",
	}),
	encoding: Schema.optionalKey(
		Schema.Literals(["utf8", "base64"]).annotate({
			description: "How content is encoded (default utf8)",
		}),
	),
	content_type: Schema.optionalKey(
		ArtifactContentType.annotate({
			description: "Media type; inferred from the path extension when omitted",
		}),
	),
})
export type ArtifactFileInput = typeof ArtifactFileInput.Type

export const ArtifactFilesInput = Schema.Array(ArtifactFileInput).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ARTIFACT_FILES),
)

export const ArtifactKeptFileInput = Schema.Struct({
	path: ArtifactPath.annotate({
		description: "Relative path inside the artifact, for example index.html or assets/app.js",
	}),
	sha256: Sha256Hex.annotate({
		description:
			"sha256 of a file in the version being replaced, to keep its bytes without sending them again",
	}),
	content_type: Schema.optionalKey(
		ArtifactContentType.annotate({
			description: "Media type; inferred from the path extension when omitted",
		}),
	),
})
export type ArtifactKeptFileInput = typeof ArtifactKeptFileInput.Type

export const ArtifactVersionFileInput = Schema.Union([ArtifactFileInput, ArtifactKeptFileInput])
export type ArtifactVersionFileInput = typeof ArtifactVersionFileInput.Type

export const ArtifactVersionFilesInput = Schema.Array(ArtifactVersionFileInput).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ARTIFACT_FILES),
)

export const ArtifactFile = Schema.Struct({
	path: ArtifactPath,
	sha256: Sha256Hex,
	size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	content_type: Schema.String,
})
export type ArtifactFile = typeof ArtifactFile.Type
