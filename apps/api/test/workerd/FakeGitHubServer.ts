import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface RecordedGitRequest {
	readonly method: string
	readonly path: string
	readonly authorization: string | undefined
	readonly status: number
}

export interface FakeGitHubServer {
	readonly baseUrl: string
	readonly requests: ReadonlyArray<RecordedGitRequest>
	readonly git: (repository: string, ...args: ReadonlyArray<string>) => string
	readonly close: () => Promise<void>
}

interface FakeRepository {
	readonly name: string
	readonly files: Readonly<Record<string, string>>
	readonly token?: string
}

const GIT_ENV = {
	GIT_AUTHOR_NAME: "Owner",
	GIT_AUTHOR_EMAIL: "owner@example.com",
	GIT_COMMITTER_NAME: "Owner",
	GIT_COMMITTER_EMAIL: "owner@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
}

const runGit = (cwd: string, args: ReadonlyArray<string>): string =>
	execFileSync("git", args, {
		cwd,
		env: { ...process.env, ...GIT_ENV },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})

const seed = (root: string, repository: FakeRepository): void => {
	const bare = join(root, `${repository.name}.git`)
	const work = join(root, "work", repository.name)
	mkdirSync(bare, { recursive: true })
	mkdirSync(work, { recursive: true })
	runGit(bare, ["init", "--bare", "--initial-branch=main"])
	runGit(bare, ["config", "http.receivepack", "true"])
	runGit(work, ["init", "--initial-branch=main"])
	for (const [path, content] of Object.entries(repository.files)) {
		writeFileSync(join(work, path), content)
	}
	runGit(work, ["add", "."])
	runGit(work, ["commit", "-m", "Initial commit"])
	runGit(work, ["push", bare, "main"])
}

const splitCgiResponse = (output: Buffer) => {
	const crlf = output.indexOf("\r\n\r\n")
	const lf = output.indexOf("\n\n")
	const end = crlf === -1 ? lf : lf === -1 ? crlf : Math.min(crlf, lf)
	const bodyStart = end === crlf ? end + 4 : end + 2
	const headers = new Map<string, string>()
	for (const line of output.subarray(0, Math.max(end, 0)).toString("utf8").split(/\r?\n/)) {
		const separator = line.indexOf(":")
		if (separator > 0) {
			headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim())
		}
	}
	const status = Number.parseInt(headers.get("status") ?? "200", 10)
	headers.delete("status")
	return { status, headers, body: end === -1 ? output : output.subarray(bodyStart) }
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const chunks: Array<Buffer> = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => resolve(Buffer.concat(chunks)))
		req.on("error", reject)
	})

const httpBackend = (root: string, req: IncomingMessage, path: string, query: string) =>
	readBody(req).then(
		(body) =>
			new Promise<Buffer>((resolve, reject) => {
				const child = spawn("git", ["http-backend"], {
					env: {
						...process.env,
						...GIT_ENV,
						GIT_PROJECT_ROOT: root,
						GIT_HTTP_EXPORT_ALL: "1",
						REQUEST_METHOD: req.method ?? "GET",
						PATH_INFO: path,
						QUERY_STRING: query,
						CONTENT_TYPE: req.headers["content-type"] ?? "",
						CONTENT_LENGTH: String(body.length),
						REMOTE_USER: "x-access-token",
						...(req.headers["git-protocol"] === undefined
							? {}
							: { GIT_PROTOCOL: String(req.headers["git-protocol"]) }),
					},
					stdio: ["pipe", "pipe", "inherit"],
				})
				const chunks: Array<Buffer> = []
				child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
				child.on("error", reject)
				child.on("close", () => resolve(Buffer.concat(chunks)))
				child.stdin.end(body)
			}),
	)

export const startFakeGitHubServer = async (
	repositories: ReadonlyArray<FakeRepository>,
): Promise<FakeGitHubServer> => {
	const root = mkdtempSync(join(tmpdir(), "checkfu-fake-github-"))
	for (const repository of repositories) {
		seed(root, repository)
	}
	const requests: Array<RecordedGitRequest> = []
	const sockets = new Set<Socket>()

	const respond = (
		req: IncomingMessage,
		res: ServerResponse,
		path: string,
		status: number,
		headers: Record<string, string>,
		body: Buffer | string,
	) => {
		requests.push({
			method: req.method ?? "GET",
			path,
			authorization: req.headers.authorization,
			status,
		})
		res.writeHead(status, headers)
		res.end(body)
	}

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const repository = repositories.find(({ name }) => url.pathname.startsWith(`/${name}/`))
		if (repository === undefined) {
			respond(req, res, url.pathname, 404, { "content-type": "text/plain" }, "Not Found")
			return
		}
		if (
			repository.token !== undefined &&
			req.headers.authorization !==
				`Basic ${Buffer.from(`x-access-token:${repository.token}`).toString("base64")}`
		) {
			respond(
				req,
				res,
				url.pathname,
				401,
				{ "content-type": "text/plain", "www-authenticate": 'Basic realm="GitHub"' },
				"Unauthorized",
			)
			return
		}
		const gitPath = `/${repository.name}.git${url.pathname.slice(repository.name.length + 1)}`
		httpBackend(root, req, gitPath, url.search.slice(1)).then(
			(output) => {
				const { status, headers, body } = splitCgiResponse(output)
				respond(req, res, url.pathname, status, Object.fromEntries(headers), body)
			},
			(error: unknown) => {
				respond(req, res, url.pathname, 500, { "content-type": "text/plain" }, String(error))
			},
		)
	})
	server.on("connection", (socket) => {
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => resolve())
	})
	const address = server.address()
	if (address === null || typeof address === "string") {
		throw new Error("Expected TCP address for fake GitHub server")
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		git: (repository, ...args) => runGit(join(root, `${repository}.git`), args),
		close: async () => {
			for (const socket of sockets) {
				socket.destroy()
			}
			await new Promise<void>((resolve) => {
				server.close(() => resolve())
			})
			rmSync(root, { recursive: true, force: true })
		},
	}
}
