import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { placedStub, placement } from "../Placement.ts"
import { SandboxError, Sandboxes, TIMED_OUT, machineIdle } from "./Sandboxes.ts"
import { WRITE_FILE } from "./WriteFile.ts"
import type { ExecOptions, Sandbox } from "./Sandboxes.ts"

export const sandboxMachineProps = Effect.gen(function* () {
	const managed = yield* Config.Boolean("CHECKFU_MANAGED_DEPLOYMENT").pipe(
		Config.withDefault(false),
	)
	if (managed) {
		const image = yield* Config.NonEmptyString("CHECKFU_SANDBOX_IMAGE")
		return { schedulingPolicy: "durable_object" as const, image }
	}
	return { schedulingPolicy: "durable_object" as const, context: `${import.meta.dirname}/image` }
})

export class SandboxMachine extends Cloudflare.Container<SandboxMachine>()(
	"SandboxMachine",
	sandboxMachineProps,
) {}

const MACHINE = "machine"
const STARTS = "starts"
interface Started {
	readonly incarnation: string
}

const TRUST_EGRESS = [
	"sh",
	"-c",
	"cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates",
]
const CERTIFICATES = "/etc/ssl/certs/ca-certificates.crt"
const TRUSTED = {
	NODE_EXTRA_CA_CERTS: CERTIFICATES,
	SSL_CERT_FILE: CERTIFICATES,
	REQUESTS_CA_BUNDLE: CERTIFICATES,
}

const EVERY_PERMIT = Number.MAX_SAFE_INTEGER
const SAVE_HEADROOM_MS = 20 * 60 * 1000

interface MachineCommand {
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string>>
	readonly timeout?: number
	readonly stdin?: Uint8Array
}

interface MachineOutput {
	readonly exitCode: number
	readonly stdout: Uint8Array
	readonly stderr: Uint8Array
}

const CALL_MS = 120_000

const run = (
	machine: Cloudflare.ContainerClient,
	argv: ReadonlyArray<string>,
	command: MachineCommand = {},
) =>
	Effect.gen(function* () {
		const process = yield* machine.exec([...argv], {
			...(command.cwd === undefined ? {} : { cwd: command.cwd }),
			env: { ...TRUSTED, ...command.env },
			...(command.stdin === undefined ? {} : { stdin: "pipe" as const }),
		})
		if (command.stdin !== undefined && process.stdin !== undefined) {
			yield* Stream.run(Stream.succeed(command.stdin), process.stdin)
		}
		const output = yield* process.output()
		return {
			exitCode: output.exitCode,
			stdout: new Uint8Array(output.stdout),
			stderr: new Uint8Array(output.stderr),
		} satisfies MachineOutput
	}).pipe(Effect.scoped, (ran) => {
		const limit = command.timeout ?? CALL_MS
		return Effect.map(Effect.timeoutOption(ran, limit), (finished) =>
			Option.getOrElse(finished, (): MachineOutput => ({
				exitCode: TIMED_OUT,
				stdout: new Uint8Array(),
				stderr: new TextEncoder().encode(`Timed out after ${limit} ms.`),
			})),
		)
	})

export class SessionSandbox extends Cloudflare.DurableObject<SessionSandbox>()(
	"SessionSandbox",
	Effect.map(
		Effect.all({
			machine: SandboxMachine,
			state: Cloudflare.DurableObjectState,
			idle: Effect.orDie(machineIdle),
		}),
		({ machine, state, idle }) =>
			Effect.gen(function* () {
				const { storage } = state.raw
				const sandbox = state.raw.id.name
				if (sandbox === undefined) {
					return yield* Effect.die(new Error("SessionSandbox must be addressed by its session id."))
				}
				const commands = yield* Semaphore.make(EVERY_PERMIT)
				const alone = Semaphore.withPermits(commands, EVERY_PERMIT)
				const keepAlive = machine.setInactivityTimeout(Duration.toMillis(idle) + SAVE_HEADROOM_MS)
				if (yield* Effect.orElseSucceed(machine.running, () => false)) {
					yield* Effect.ignore(keepAlive)
				}

				const start = Effect.gen(function* () {
					const entrypoint = state.exports.default
					if (entrypoint === undefined) {
						return yield* Effect.die(new Error("The Worker hosting a sandbox has no entrypoint."))
					}
					yield* machine.start({
						entrypoint: ["sleep", "infinity"],
						enableInternet: false,
						instance: "standard-1",
					})
					const egress = yield* entrypoint({ props: { sandbox } })
					yield* machine.interceptAllOutboundHttp(egress)
					yield* machine.interceptOutboundHttps("*", egress)
					const set = yield* run(machine, TRUST_EGRESS)
					if (set.exitCode !== 0) {
						return yield* Effect.die(
							new Error(`The machine could not be set up: ${new TextDecoder().decode(set.stderr)}`),
						)
					}
				})

				const started = (): Started | undefined => storage.kv.get<Started>(MACHINE)

				return {
					open: () =>
						Effect.gen(function* () {
							const running = yield* machine.running
							const now = started()
							if (running && now !== undefined) {
								yield* keepAlive
								return now.incarnation
							}
							storage.kv.delete(MACHINE)
							if (running) {
								yield* machine.destroy()
							}
							yield* Effect.onError(Effect.andThen(start, keepAlive), () =>
								Effect.ignore(machine.destroy()),
							)
							const starts = (storage.kv.get<number>(STARTS) ?? 0) + 1
							const incarnation = String(starts)
							storage.kv.put(STARTS, starts)
							storage.kv.put(MACHINE, { incarnation } satisfies Started)
							return incarnation
						}).pipe(alone, Effect.orDie),
					exec: (incarnation: string, argv: ReadonlyArray<string>, command?: MachineCommand) =>
						Effect.gen(function* () {
							if (started()?.incarnation !== incarnation || !(yield* machine.running)) {
								return yield* Effect.die(new Error("The machine is not running."))
							}
							return yield* run(machine, argv, command)
						}).pipe(Semaphore.withPermits(commands, 1), Effect.orDie),
					remove: () =>
						Effect.gen(function* () {
							storage.kv.delete(MACHINE)
							if (yield* machine.running) {
								yield* machine.destroy()
							}
						}).pipe(alone, Effect.orDie),
				}
			}),
	),
) {}

export const SandboxesCloudflare = Layer.effect(
	Sandboxes,
	Effect.gen(function* () {
		const objectOf = placedStub(yield* SessionSandbox, yield* Effect.orDie(placement))
		const runtime = yield* Cloudflare.Worker
		const asked = <A, E>(
			call: Effect.Effect<A, E, RuntimeContext>,
		): Effect.Effect<A, SandboxError> =>
			Effect.catchCause(Effect.provideService(call, RuntimeContext, runtime), (cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.fail(new SandboxError({ message: Cause.pretty(cause) })),
			)
		const text = new TextDecoder()

		const sandboxOf = (key: string, incarnation: string): Sandbox => {
			const read = (path: string) =>
				Effect.flatMap(asked(objectOf(key).exec(incarnation, ["cat", "--", path])), (output) =>
					output.exitCode === 0
						? Effect.succeed(output.stdout)
						: Effect.fail(new SandboxError({ message: text.decode(output.stderr).trim() })),
				)
			return {
				incarnation,
				exec: (command, options: ExecOptions = {}) =>
					Effect.map(
						asked(
							objectOf(key).exec(
								incarnation,
								typeof command === "string" ? ["sh", "-c", command] : command,
								{
									...(options.cwd === undefined ? {} : { cwd: options.cwd }),
									...(options.env === undefined ? {} : { env: options.env }),
									...(options.timeout === undefined
										? {}
										: { timeout: Duration.toMillis(Duration.fromInputUnsafe(options.timeout)) }),
								},
							),
						),
						(output) => ({
							exitCode: output.exitCode,
							stdout: text.decode(output.stdout),
							stderr: text.decode(output.stderr),
						}),
					),
				readFile: read,
				readTextFile: (path) => Effect.map(read(path), (bytes) => text.decode(bytes)),
				writeFile: (path, content) =>
					Effect.flatMap(
						asked(
							objectOf(key).exec(incarnation, ["sh", "-c", WRITE_FILE, "sh", path], {
								stdin: typeof content === "string" ? new TextEncoder().encode(content) : content,
							}),
						),
						(output) =>
							output.exitCode === 0
								? Effect.void
								: Effect.fail(new SandboxError({ message: text.decode(output.stderr).trim() })),
					),
			}
		}

		return {
			open: (key) =>
				Effect.map(asked(objectOf(key).open()), (incarnation) => sandboxOf(key, incarnation)),
			remove: (key) => asked(objectOf(key).remove()),
		}
	}),
)

export const sandboxEgress = <R>(
	egress: (
		key: string,
		request: HttpServerRequest.HttpServerRequest,
	) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
) =>
	Effect.map(Cloudflare.WorkerExecutionContext, (ctx) =>
		Effect.gen(function* () {
			const { sandbox } = yield* ctx.props
			return typeof sandbox === "string"
				? yield* egress(sandbox, yield* HttpServerRequest.HttpServerRequest)
				: HttpServerResponse.empty({ status: 404 })
		}),
	)
