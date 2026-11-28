import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const [cli, baseUrl, apiKey, project] = process.argv.slice(2)
const execute = promisify(execFile)
const covered = new Set()
const raw = async (args, stdin = "") => {
	const command = args.slice(0, 2).join(" ")
	covered.add(command)
	// Keep the last attempted user action visible if the outer process deadline fires.
	// Arguments and stdin can contain secrets; trace only the command name.
	process.stderr.write(`[CLI journey] ${command}\n`)
	const child = execute(
		process.execPath,
		["--no-experimental-strip-types", cli, "--format", "json", ...args],
		{ timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
	)
	child.child.stdin.end(stdin)
	return child
}
const run = async (args, body) =>
	JSON.parse((await raw(args, body === undefined ? "" : JSON.stringify(body))).stdout)
const fails = async (args, exitCode, message, body) =>
	assert.rejects(raw(args, body === undefined ? "" : JSON.stringify(body)), (error) => {
		assert.equal(error.code, exitCode)
		assert.equal(error.stdout, "")
		assert.match(error.stderr, message)
		return true
	})
const get = async (path) => {
	const response = await fetch(`${baseUrl}/v1/${path}`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	})
	assert.equal(response.status, 200, path)
	return response.json()
}
const listed = async (args, id) => {
	for (let attempt = 0; attempt < 100; attempt++) {
		const page = await run(args)
		if (page.data.some((entry) => entry.id === id)) {
			return page
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 10)
		})
	}
	assert.fail(`${args.join(" ")} never listed ${id}`)
}

// Resource versions and a stale write: inspect the backend independently of CLI output.
const agent = await run([
	"agents",
	"create",
	"--name",
	"CLI full journey",
	"--model",
	"gpt-4o-mini",
])
const agentId = ["--agent-id", agent.id]
await run([
	"agents",
	"update",
	...agentId,
	"--current-version",
	"1",
	"--system",
	"Exact instructions\nwith whitespace.",
])
assert.equal((await get(`agents/${agent.id}`)).version, 2)
assert.equal(
	(await run(["agents", "retrieve", ...agentId])).system,
	"Exact instructions\nwith whitespace.",
)
await fails(["agents", "update", ...agentId, "--current-version", "1", "--name", "Stale"], 5, /409/)
assert.deepEqual(
	(await run(["agents:versions", "list", ...agentId])).data.map(({ version }) => version),
	[2, 1],
)
await listed(["agents", "list", "--limit", "100"], agent.id)

const environment = await run(["environments", "create", "--name", "CLI environment"])
const environmentId = ["--environment-id", environment.id]
await run([
	"environments",
	"update",
	...environmentId,
	"--current-version",
	"1",
	"--name",
	"Updated environment",
])
assert.equal(
	(await run(["environments", "retrieve", ...environmentId])).name,
	"Updated environment",
)
await listed(["environments", "list"], environment.id)

// Durable memory, binary-safe artifact files, and credentials must all survive real transport.
const store = await run(["memory-stores", "create", "--name", "CLI memory"])
const storeId = ["--memory-store-id", store.id]
await run(["memory-stores", "update", ...storeId, "--description", "Shared notes"])
assert.equal((await run(["memory-stores", "retrieve", ...storeId])).description, "Shared notes")
await listed(["memory-stores", "list"], store.id)
const memory = await run([
	"memory-stores:memories",
	"create",
	...storeId,
	"--path",
	"/notes/hello.md",
	"--content",
	"hello",
])
const memoryId = [...storeId, "--memory-id", memory.id]
await run([
	"memory-stores:memories",
	"update",
	...memoryId,
	"--content",
	"updated 🐈",
	"--precondition",
	JSON.stringify({ type: "content_sha256", content_sha256: memory.content_sha256 }),
])
const savedMemory = await get(`memory_stores/${store.id}/memories/${memory.id}`)
assert.equal(savedMemory.content_sha256, createHash("sha256").update("updated 🐈").digest("hex"))
assert.equal((await run(["memory-stores:memories", "retrieve", ...memoryId])).content, "updated 🐈")
await fails(
	[
		"memory-stores:memories",
		"update",
		...memoryId,
		"--content",
		"overwrite",
		"--precondition",
		JSON.stringify({ type: "content_sha256", content_sha256: memory.content_sha256 }),
	],
	5,
	/409/,
)
await listed(["memory-stores:memories", "list", ...storeId], memory.id)

const binary = Buffer.from([0, 255, 128, 10, 13, 0])
const artifact = await run(["artifacts", "create"], {
	name: "CLI files",
	files: [
		{ path: "notes.txt", content: "original\n" },
		{ path: "bytes.bin", content: binary.toString("base64"), encoding: "base64" },
	],
})
const artifactId = ["--artifact-id", artifact.id]
assert.equal((await run(["artifacts", "retrieve", ...artifactId])).version, 1)
await listed(["artifacts", "list"], artifact.id)
const downloaded = await run([
	"artifacts:versions",
	"file",
	...artifactId,
	"--current-version",
	"1",
	"--file",
	"bytes.bin",
])
assert.equal(downloaded.encoding, "base64")
assert.deepEqual(Buffer.from(downloaded.content, "base64"), binary)
await run(["artifacts:versions", "create", ...artifactId], {
	version: 1,
	files: [{ path: "notes.txt", content: "next version\n" }],
})
assert.equal((await get(`artifacts/${artifact.id}/versions/1`)).files.length, 2)
assert.equal(
	(await run(["artifacts:versions", "retrieve", ...artifactId, "--current-version", "2"])).files
		.length,
	1,
)
const link = await run(["artifacts:versions", "link", ...artifactId, "--current-version", "2"], {})
assert.equal(link.artifact_id, artifact.id)
assert.match(link.url, /^https?:\/\//)
const published = await run(["artifacts", "publish", ...artifactId], { version: "latest" })
assert.notEqual(published.publication, null)
assert.equal((await run(["artifacts", "unpublish", ...artifactId])).publication, null)

const notes = [...artifactId, "--collection", "notes"]
const note = await run([
	"artifacts:data",
	"add",
	...notes,
	"--data",
	JSON.stringify({ text: "first" }),
])
assert.deepEqual(note.data, { text: "first" })
const pinnedNote = [...notes, "--document-id", "pinned"]
assert.equal((await run(["artifacts:data", "put", ...pinnedNote], { data: ["a", 1] })).id, "pinned")
assert.deepEqual((await run(["artifacts:data", "retrieve", ...pinnedNote])).data, ["a", 1])
assert.equal((await run(["artifacts:data", "list", ...notes])).data.length, 2)
assert.equal((await run(["artifacts:data", "describe", ...artifactId])).collections[0].documents, 2)
assert.equal(
	(await run(["artifacts:data", "delete", ...pinnedNote])).type,
	"artifact_document_deleted",
)

const vault = await run(["vaults", "create", "--display-name", "CLI secrets"])
const vaultId = ["--vault-id", vault.id]
await run(["vaults", "update", ...vaultId, "--display-name", "Updated vault"])
assert.equal((await run(["vaults", "retrieve", ...vaultId])).display_name, "Updated vault")
await listed(["vaults", "list"], vault.id)
const credential = await run(["vaults:credentials", "create", ...vaultId], {
	display_name: "Example credential",
	auth: {
		type: "static_bearer",
		token: "private_test_token_123",
		mcp_server_url: "https://mcp.example.com/mcp",
	},
})
const credentialId = [...vaultId, "--credential-id", credential.id]
assert.equal(JSON.stringify(credential).includes("private_test_token_123"), false)
await run(["vaults:credentials", "update", ...credentialId, "--display-name", "Renamed credential"])
assert.equal(
	(await run(["vaults:credentials", "retrieve", ...credentialId])).display_name,
	"Renamed credential",
)
await listed(["vaults:credentials", "list", ...vaultId], credential.id)
await run(["vaults:credentials", "archive", ...credentialId])
await run(["vaults:credentials", "delete", ...credentialId])

// Sessions pin references; repository credential replacement must never echo the secret.
const session = await run(["sessions", "create"], {
	agent: agent.id,
	environment_id: environment.id,
	resources: [
		{ type: "memory_store", memory_store_id: store.id },
		{ type: "artifact", artifact_id: artifact.id },
		{
			type: "github_repository",
			url: "https://github.com/checkfu/checkfu",
			authorization_token: "original_repository_secret",
		},
	],
})
const sessionId = ["--session-id", session.id]
assert.equal((await run(["sessions", "retrieve", ...sessionId])).agent.version, 2)
await listed(["sessions", "list"], session.id)
const resources = (await run(["sessions:resources", "list", ...sessionId])).data
assert.equal(resources.length, 3)
const repository = resources.find(({ type }) => type === "github_repository")
const resourceId = [...sessionId, "--resource-id", repository.id]
assert.equal(
	(await run(["sessions:resources", "retrieve", ...resourceId])).url,
	"https://github.com/checkfu/checkfu",
)
const replaced = await run(["sessions:resources", "update", ...resourceId], {
	authorization_token: "replacement_repository_secret",
})
assert.equal(JSON.stringify(replaced).includes("replacement_repository_secret"), false)
await run(["sessions:events", "send", ...sessionId], {
	events: [
		{ type: "user.message", content: [{ type: "text", text: "A full installed CLI turn" }] },
	],
})
await raw(["sessions", "connect", session.id], "Final message without newline")
await run(["sessions", "archive", ...sessionId])
const events = (await run(["sessions:events", "list", ...sessionId, "--limit", "100"])).data
assert.equal(events.filter(({ type }) => type === "agent.message").length, 2)
const stream = await raw(["sessions:events", "stream", ...sessionId])
assert.match(stream.stdout, /Final message without newline/)
const outputs = await run(["sessions:outputs", "retrieve", ...sessionId])
assert.equal(outputs.type, "session_outputs")
assert.deepEqual(outputs.files, [])

const automation = await run(["automations", "create"], {
	name: "CLI report",
	agent: agent.id,
	environment_id: environment.id,
	initial_events: [
		{ type: "user.message", content: [{ type: "text", text: "Produce the report" }] },
	],
	schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
})
const automationId = ["--automation-id", automation.id]
await run(["automations", "pause", ...automationId])
await run(["automations", "update", ...automationId, "--description", "Updated report"])
await run(["automations", "unpause", ...automationId])
await run(["automations", "run", ...automationId])
await listed(["automations", "list"], automation.id)
assert.equal((await run(["automations", "retrieve", ...automationId])).run_count, 1)
let runs
for (let i = 0; i < 100; i++) {
	runs = (await run(["automations:runs", "list", ...automationId])).data
	if (runs.length) {
		break
	}
	await new Promise((resolve) => {
		setTimeout(resolve, 10)
	})
}
assert.equal(runs.length, 1)
assert.equal(
	(await run(["automations:runs", "retrieve", ...automationId, "--run", "1"])).id,
	runs[0].id,
)
assert.equal(
	(await run(["automation-runs", "retrieve", "--automation-run-id", runs[0].id])).automation_id,
	automation.id,
)
await run(["automations", "archive", ...automationId])

const webhook = await run(["webhooks", "create"], {
	url: "https://hooks.example.com/checkfu",
	event_types: ["*"],
	description: "CLI webhook",
})
const webhookId = ["--webhook-id", webhook.id]
assert.match(webhook.signing_secret, /^whsec_/)
await run(["webhooks", "update", ...webhookId, "--description", "Updated webhook"])
await listed(["webhooks", "list"], webhook.id)
const retrievedWebhook = await run(["webhooks", "retrieve", ...webhookId])
assert.equal(retrievedWebhook.description, "Updated webhook")
assert.equal("signing_secret" in retrievedWebhook, false)
assert.equal((await run(["webhooks", "pause", ...webhookId])).status, "paused")
assert.equal((await run(["webhooks", "resume", ...webhookId])).status, "active")
const rotated = await run(["webhooks", "rotate-secret", ...webhookId])
assert.notEqual(rotated.signing_secret, webhook.signing_secret)
const delivery = await run(["webhooks", "test", ...webhookId])
const deliveryId = [...webhookId, "--delivery-id", delivery.id]
await listed(["webhooks:deliveries", "list", ...webhookId], delivery.id)
assert.equal(
	(await run(["webhooks:deliveries", "retrieve", ...deliveryId])).event_type,
	"webhook.test",
)
const redelivered = await run(["webhooks:deliveries", "redeliver", ...deliveryId])
assert.equal(redelivered.webhook_id, webhook.id)
await run(["webhooks", "delete", ...webhookId])

// A file uploaded from disk comes back byte for byte, and is gone once deleted.
const uploadedBytes = Buffer.from(Array.from({ length: 200_000 }, (_, index) => (index * 31) % 251))
const uploadPath = join(project, "upload.bin")
await writeFile(uploadPath, uploadedBytes)
const file = await run(["files", "upload", uploadPath, "--filename", "data.bin"])
const fileId = ["--file-id", file.id]
assert.equal(file.size, uploadedBytes.byteLength)
assert.equal(file.sha256, createHash("sha256").update(uploadedBytes).digest("hex"))
assert.equal((await get(`files/${file.id}`)).filename, "data.bin")
assert.equal((await run(["files", "retrieve", ...fileId])).content_type, "application/octet-stream")
await listed(["files", "list"], file.id)
const downloadPath = join(project, "download.bin")
await run(["files", "download", ...fileId, "--output", downloadPath])
assert.deepEqual(await readFile(downloadPath), uploadedBytes)
await fails(["files", "download", ...fileId, "--output", downloadPath], 2, /already exists/)
await run(["files", "delete", ...fileId])
await fails(["files", "retrieve", ...fileId], 4, /404/)

await run(["artifacts", "delete", ...artifactId])
await run(["memory-stores:memories", "delete", ...memoryId], { precondition: { type: "none" } })
await run(["memory-stores", "archive", ...storeId])
await run(["memory-stores", "delete", ...storeId])
await run(["vaults", "archive", ...vaultId])
await run(["vaults", "delete", ...vaultId])
await run(["agents", "archive", ...agentId])
await run(["environments", "archive", ...environmentId])
await run(["environments", "delete", ...environmentId])

// Local authoring and reconciliation through the installed binary, with actual lock/data readback.
const authored = join(project, "authored")
await mkdir(join(authored, "agents"), { recursive: true })
const agentFile = join(authored, "agents", "assistant.md")
await writeFile(
	agentFile,
	"---\nname: Authored CLI\nmodel: gpt-4o-mini\n---\nExact authored instructions.\n",
)
assert.equal((await run(["agent", "info", agentFile])).system, "Exact authored instructions.")
process.chdir(authored)
await run(["apply", ".", "--dry-run"])
await run(["apply", ".", "--yes"])
const lock = JSON.parse(await readFile(join(authored, "checkfu-lock.json"), "utf8"))
assert.equal(Object.keys(lock.resources).length, 1)
const authoredId = Object.values(lock.resources)[0].id
assert.equal((await get(`agents/${authoredId}`)).system, "Exact authored instructions.")
const noChanges = await raw(["apply", ".", "--dry-run"])
assert.match(noChanges.stdout, /unchanged/)
process.stdout.write(
	JSON.stringify({
		commands: [...covered].sort((a, b) => a.localeCompare(b)),
		binary_sha256: createHash("sha256").update(binary).digest("hex"),
	}),
)
