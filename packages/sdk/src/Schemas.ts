import * as Schema from "effect/Schema"

// ---------------------------------------------------------------------------
// Shared limits & primitive schemas
// ---------------------------------------------------------------------------

export const MAX_AGENT_NAME_LENGTH = 256
export const MAX_AGENT_DESCRIPTION_LENGTH = 2048
export const MAX_AGENT_SYSTEM_LENGTH = 100_000

export const MAX_ENVIRONMENT_NAME_LENGTH = 256
export const MAX_ENVIRONMENT_DESCRIPTION_LENGTH = 1024

export const MAX_AUTOMATION_ID_LENGTH = 128
export const MAX_AUTOMATION_NAME_LENGTH = 256
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

export const SINGLE_PATH_SEGMENT_MESSAGE =
	'must be a single non-empty path segment (not "." or "..")'

export const isSinglePathSegment = (value: string): boolean =>
	value.length > 0 &&
	value !== "." &&
	value !== ".." &&
	!value.includes("/") &&
	!value.includes("\\")

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

// ---------------------------------------------------------------------------
// Branded resource IDs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Agent schemas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Environment schemas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Session schemas
// ---------------------------------------------------------------------------

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

/**
 * Canonical payload field definitions for every public session event, shared
 * between `@checkfu/domain` event classes and the wire `SessionEvent` union.
 */
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

// ---------------------------------------------------------------------------
// Session resources
// ---------------------------------------------------------------------------

export const MAX_SESSION_REPOSITORIES = 8
export const MAX_MOUNT_PATH_LENGTH = 1024
export const MAX_BRANCH_NAME_LENGTH = 255
export const REPOSITORY_MOUNT_ROOT = "/workspace"

export const SessionResourceId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("SessionResourceId"))
export type SessionResourceId = typeof SessionResourceId.Type

// A path segment other than "." and "..", with no slash, backslash or control character.
// Written without lookaround and without Unicode classes, so that every engine a client
// validates the published schema with can run it.
const SEGMENT_CHAR = String.raw`[^/\\\u0000-\u001f\u007f-\u009f]`
const SEGMENT_START = String.raw`[^/\\.\u0000-\u001f\u007f-\u009f]`
const PATH_SEGMENT = String.raw`(?:${SEGMENT_START}${SEGMENT_CHAR}*|\.${SEGMENT_START}${SEGMENT_CHAR}*|\.\.${SEGMENT_CHAR}+)`

/** An absolute path whose every segment is a name. */
export const ABSOLUTE_PATH = new RegExp(`^(?:/${PATH_SEGMENT})+$`, "u")

export const MountPath = Schema.String.check(
	Schema.isMaxLength(MAX_MOUNT_PATH_LENGTH),
	Schema.isPattern(ABSOLUTE_PATH),
)

export const RepositoryMountPath = MountPath.check(
	Schema.isPattern(/^\/workspace\/./u, {
		expected: `a path inside ${REPOSITORY_MOUNT_ROOT}`,
	}),
)

const REPOSITORY_URL =
	/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/u

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

// Held only by the session's workspace: no event, view or saga step carries it.
export const RepositoryToken = Schema.Redacted(
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_REPOSITORY_TOKEN_LENGTH)),
)
export type RepositoryToken = typeof RepositoryToken.Type

export const RepositoryCheckout = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("branch"),
		name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BRANCH_NAME_LENGTH)),
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

export const MAX_SESSION_MEMORY_STORES = 8
export const MAX_MEMORY_INSTRUCTIONS_LENGTH = 4096
export const MEMORY_MOUNT_ROOT = "/mnt/memory"

export const MemoryAccess = Schema.Literals(["read_write", "read_only"])
export type MemoryAccess = typeof MemoryAccess.Type

export const MemoryInstructions = Schema.String.check(
	Schema.isMaxLength(MAX_MEMORY_INSTRUCTIONS_LENGTH),
)

export const MemoryMountPath = MountPath.check(
	Schema.isPattern(/^\/mnt\/memory\/[^/]+$/u, {
		expected: `a directory directly inside ${MEMORY_MOUNT_ROOT}`,
	}),
)

/** Where a store is mounted: its name as one lower-case segment, or its id when the name has no letter or digit. */
export const memoryMountPath = (name: string, memoryStoreId: string): string => {
	const slug = name
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "")
	return `${MEMORY_MOUNT_ROOT}/${slug.length === 0 ? memoryStoreId : slug}`
}

// The store's name and description are kept as they were when the session was admitted.
export const MemoryStoreResource = Schema.Struct({
	id: SessionResourceId,
	type: Schema.Literal("memory_store"),
	memory_store_id: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
	),
	access: MemoryAccess,
	instructions: Schema.NullOr(MemoryInstructions),
	name: Schema.String,
	description: Schema.String,
	mount_path: MemoryMountPath,
})
export type MemoryStoreResource = typeof MemoryStoreResource.Type

export const SessionMount = Schema.Union([GitHubRepositoryResource, MemoryStoreResource])
export type SessionMount = typeof SessionMount.Type

export const repositoriesOf = (
	resources: ReadonlyArray<SessionMount>,
): ReadonlyArray<GitHubRepositoryResource> =>
	resources.filter((resource) => resource.type === "github_repository")

export const memoryStoresOf = (
	resources: ReadonlyArray<SessionMount>,
): ReadonlyArray<MemoryStoreResource> =>
	resources.filter((resource) => resource.type === "memory_store")

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

// A repository's token is found by its URL, and GitHub reads owner and name without case.
const mountEachRepositoryOnce = (resources: ReadonlyArray<SessionMount>): boolean => {
	const urls = repositoriesOf(resources).map((resource) => resource.url.toLowerCase())
	return new Set(urls).size === urls.length
}

const areWithinLimits = (resources: ReadonlyArray<SessionMount>): boolean =>
	repositoriesOf(resources).length <= MAX_SESSION_REPOSITORIES &&
	memoryStoresOf(resources).length <= MAX_SESSION_MEMORY_STORES

const attachEachStoreOnce = (resources: ReadonlyArray<SessionMount>): boolean => {
	const stores = memoryStoresOf(resources).map((resource) => resource.memory_store_id)
	return new Set(stores).size === stores.length
}

export const SessionMounts = Schema.Array(SessionMount).check(
	Schema.isMaxLength(MAX_SESSION_REPOSITORIES + MAX_SESSION_MEMORY_STORES),
	Schema.makeFilter(areWithinLimits, {
		expected: `at most ${MAX_SESSION_REPOSITORIES} repositories and ${MAX_SESSION_MEMORY_STORES} memory stores`,
	}),
	Schema.makeFilter(attachEachStoreOnce, { expected: "each memory store attached once" }),
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

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export const AutomationName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_AUTOMATION_NAME_LENGTH),
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
	agent_id: ResourceId,
	agent_version: Schema.NullOr(PositiveInt),
	environment_id: ResourceId,
	text: MessageText,
	schedule: AutomationSchedule,
	status: Schema.Literals(["active", "paused", "archived"]),
	pause_reason: Schema.NullOr(Schema.String),
	runs: NonNegativeInt,
	activation: NonNegativeInt,
	upcoming: Schema.Array(NonNegativeInt),
	last_run_at: Schema.NullOr(Schema.DateTimeUtc),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type AutomationSnapshot = typeof AutomationSnapshot.Type

// ---------------------------------------------------------------------------
// Memory stores
// ---------------------------------------------------------------------------

export const MemoryStoreId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("MemoryStoreId"))
export type MemoryStoreId = typeof MemoryStoreId.Type

// Derived from the store and the path, so one path in a store is one memory.
export const MemoryId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("MemoryId"))
export type MemoryId = typeof MemoryId.Type

// A store's index of its memories is kept as one stored row, which holds 2 MiB. At these limits a
// full index of the longest paths in 3-byte characters is about 1 MiB.
export const MAX_MEMORIES_PER_STORE = 1000
export const MAX_MEMORY_CONTENT_BYTES = 100_000
export const MAX_MEMORY_PATH_LENGTH = 256
export const MAX_MEMORY_STORE_NAME_LENGTH = 256
export const MAX_MEMORY_STORE_DESCRIPTION_LENGTH = 1024

export const MemoryStoreName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_MEMORY_STORE_NAME_LENGTH),
)
export const MemoryStoreDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_MEMORY_STORE_DESCRIPTION_LENGTH),
)

// Absolute inside the store, with no empty, "." or ".." segment, no backslash and no control character.
export const MemoryPath = Schema.String.check(
	Schema.isMaxLength(MAX_MEMORY_PATH_LENGTH),
	Schema.isPattern(ABSOLUTE_PATH, { expected: "an absolute path such as /notes/todo.md" }),
)
export type MemoryPath = typeof MemoryPath.Type

// Commands and events hold a path and a hash by length only. Verify makes up
// command inputs and cannot make one up to fit a pattern, so the HTTP layer and
// the workspace check `MemoryPath` and `ContentSha256` before they send a command.
export const RecordedMemoryPath = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_MEMORY_PATH_LENGTH),
)
export const RecordedSha256 = Schema.String.check(Schema.isMinLength(64), Schema.isMaxLength(64))

// 100 kB of UTF-8 is at most 100,000 UTF-16 units; the byte count is checked where it is measured.
// Text whose every UTF-16 surrogate is paired: the only text that has one UTF-8 encoding, so its
// hash and size are those of what is stored.
const isWellFormedText = Schema.makeFilter((text: string) => text.isWellFormed(), {
	expected: "well-formed Unicode text (no unpaired surrogates)",
})

export const MemoryContent = Schema.String.check(
	Schema.isMaxLength(MAX_MEMORY_CONTENT_BYTES),
	isWellFormedText,
)

export const ContentSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))

export const MemorySize = NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_MEMORY_CONTENT_BYTES))

export const MemoryOperation = Schema.Literals(["created", "modified"])

/** What must be true of the memory for a write to apply. */
export const WritePrecondition = Schema.Union([
	Schema.Struct({ type: Schema.Literal("none") }),
	Schema.Struct({ type: Schema.Literal("absent") }),
	Schema.Struct({ type: Schema.Literal("present") }),
	Schema.Struct({ type: Schema.Literal("content_sha256"), content_sha256: RecordedSha256 }),
])
export type WritePrecondition = typeof WritePrecondition.Type

export const MemoryStoreSnapshot = Schema.Struct({
	id: MemoryStoreId,
	type: Schema.Literal("memory_store"),
	name: MemoryStoreName,
	description: MemoryStoreDescription,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type MemoryStoreSnapshot = typeof MemoryStoreSnapshot.Type

export const MemorySnapshot = Schema.Struct({
	id: MemoryId,
	type: Schema.Literal("memory"),
	memory_store_id: MemoryStoreId,
	path: RecordedMemoryPath,
	content: MemoryContent,
	content_sha256: RecordedSha256,
	content_size_bytes: MemorySize,
	version: PositiveInt,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
})
export type MemorySnapshot = typeof MemorySnapshot.Type

export const MemoryIndexEntry = Schema.Struct({
	id: MemoryId,
	path: RecordedMemoryPath,
	content_sha256: RecordedSha256,
	content_size_bytes: MemorySize,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
})
export type MemoryIndexEntry = typeof MemoryIndexEntry.Type

// ---------------------------------------------------------------------------
// Artifact schemas
// ---------------------------------------------------------------------------

export const MAX_ARTIFACT_NAME_LENGTH = 256
export const MAX_ARTIFACT_FILES = 64
export const MAX_ARTIFACT_FILE_BYTES = 1024 * 1024
export const MAX_ARTIFACT_TOTAL_BYTES = 4 * 1024 * 1024
export const MAX_ARTIFACT_PATH_LENGTH = 512
export const MAX_ARTIFACT_CONTENT_TYPE_LENGTH = 128

// The request body limit of the two upload endpoints: JSON escaping may triple the decoded total.
// Content that escapes worse, such as control characters, has to be sent as base64.
const JSON_ESCAPE_ALLOWANCE = 3
export const MAX_ARTIFACT_BODY_BYTES =
	MAX_ARTIFACT_TOTAL_BYTES * JSON_ESCAPE_ALLOWANCE +
	MAX_ARTIFACT_FILES * (MAX_ARTIFACT_PATH_LENGTH * 6 + 512) +
	16 * 1024

export const ArtifactId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("ArtifactId"),
)
export type ArtifactId = typeof ArtifactId.Type

export const ArtifactName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_ARTIFACT_NAME_LENGTH),
)

// Relative, with no empty, "." or ".." segment, no backslash, and no control character or line
// separator. Published, so written without lookaround or Unicode property classes.
const PATH_EXCLUDED = String.raw`/\\\u0000-\u001f\u007f-\u009f\u2028\u2029`
const ARTIFACT_PATH_SEGMENT = String.raw`(?:[^.${PATH_EXCLUDED}][^${PATH_EXCLUDED}]*|\.[^.${PATH_EXCLUDED}][^${PATH_EXCLUDED}]*|\.\.[^${PATH_EXCLUDED}]+)`
const ARTIFACT_PATH = new RegExp(
	String.raw`^${ARTIFACT_PATH_SEGMENT}(?:/${ARTIFACT_PATH_SEGMENT})*$`,
	"u",
)

export const ArtifactPath = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_ARTIFACT_PATH_LENGTH),
	// No unpaired surrogate: the one rule the pattern cannot state without a property class.
	Schema.makeFilter((path) => (path.isWellFormed() ? undefined : "Expected well-formed Unicode")),
	Schema.isPattern(ARTIFACT_PATH),
)
export type ArtifactPath = typeof ArtifactPath.Type

// Published, so written with the u flag and no lookaround; the i flag would let [a-z] match
// U+017F and U+212A under u.
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

export const ArtifactFile = Schema.Struct({
	path: ArtifactPath,
	sha256: Sha256Hex,
	size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	content_type: Schema.String,
})
export type ArtifactFile = typeof ArtifactFile.Type
