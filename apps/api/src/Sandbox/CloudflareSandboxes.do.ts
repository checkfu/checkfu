import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { SandboxError, Sandboxes } from "./Sandboxes.ts"
import type { ExecOptions, Sandbox } from "./Sandboxes.ts"

/** The image a sandbox runs. Its object starts it, so nothing runs while a session is idle. */
export class SandboxMachine extends Cloudflare.Container<SandboxMachine>()("SandboxMachine", {
	schedulingPolicy: "durable_object",
	image: "node:24-slim",
}) {}

const SNAPSHOT = "snapshot"

// The machine has no program of its own: it waits, and every command is run in it.
const startOptions = (snapshot: Cloudflare.ContainerSnapshot | undefined) => ({
	entrypoint: ["sleep", "infinity"],
	enableInternet: false,
	instance: "basic" as const,
	...(snapshot === undefined ? {} : { containerSnapshot: snapshot }),
})

const TIMED_OUT = 124

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

/**
 * One sandbox: a Cloudflare Container that belongs to this object. A container's disk does not
 * outlive it, so `suspend` saves the disk as a snapshot before stopping, and the next start
 * restores it.
 */
export class SessionSandbox extends Cloudflare.DurableObject<SessionSandbox>()(
	"SessionSandbox",
	Effect.map(
		Effect.all({ machine: SandboxMachine, state: Cloudflare.DurableObjectState }),
		({ machine, state }) =>
			Effect.sync(() => {
				const { storage } = state.raw

				// A no-op while the machine runs; a stopped one starts from its last snapshot.
				const started = Effect.suspend(() =>
					machine.start(startOptions(storage.kv.get<Cloudflare.ContainerSnapshot>(SNAPSHOT))),
				)

				const exec = (argv: ReadonlyArray<string>, command: MachineCommand = {}) =>
					Effect.gen(function* () {
						yield* started
						const process = yield* machine.exec([...argv], {
							...(command.cwd === undefined ? {} : { cwd: command.cwd }),
							...(command.env === undefined ? {} : { env: { ...command.env } }),
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
					}).pipe(
						// Closing the scope kills a command that ran past its time.
						Effect.scoped,
						(run) =>
							command.timeout === undefined
								? run
								: Effect.map(Effect.timeoutOption(run, command.timeout), (finished) =>
										Option.getOrElse(finished, (): MachineOutput => ({
											exitCode: TIMED_OUT,
											stdout: new Uint8Array(),
											stderr: new TextEncoder().encode(`Timed out after ${command.timeout} ms.`),
										})),
									),
						Effect.orDie,
					)

				return {
					open: () => Effect.orDie(started),
					exec,
					suspend: () =>
						Effect.gen(function* () {
							if (!(yield* machine.running)) {
								return
							}
							storage.kv.put(SNAPSHOT, yield* machine.snapshotContainer({ name: "workspace" }))
							yield* machine.destroy()
						}).pipe(Effect.orDie),
					remove: () =>
						Effect.gen(function* () {
							if (yield* machine.running) {
								yield* machine.destroy()
							}
							storage.kv.delete(SNAPSHOT)
						}).pipe(Effect.orDie),
				}
			}),
	),
) {}

const WRITE_FILE = 'mkdir -p "$(dirname "$1")" && cat > "$1"'

/** `Sandboxes` on Cloudflare Containers: the key names the object that owns the machine. */
export const SandboxesCloudflare = Layer.effect(
	Sandboxes,
	Effect.gen(function* () {
		const objects = yield* SessionSandbox
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

		const sandboxOf = (key: string): Sandbox => {
			const object = objects.getByName(key)
			const read = (path: string) =>
				Effect.flatMap(asked(object.exec(["cat", "--", path])), (output) =>
					output.exitCode === 0
						? Effect.succeed(output.stdout)
						: Effect.fail(new SandboxError({ message: text.decode(output.stderr).trim() })),
				)
			return {
				exec: (command, options: ExecOptions = {}) =>
					Effect.map(
						asked(
							object.exec(typeof command === "string" ? ["sh", "-c", command] : command, options),
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
							object.exec(["sh", "-c", WRITE_FILE, "sh", path], {
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
			open: (key) => Effect.as(asked(objects.getByName(key).open()), sandboxOf(key)),
			suspend: (key) => asked(objects.getByName(key).suspend()),
			remove: (key) => asked(objects.getByName(key).remove()),
		}
	}),
)
