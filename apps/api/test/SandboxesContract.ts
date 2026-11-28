import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { Sandboxes, TIMED_OUT } from "../src/Sandbox/Sandboxes.ts"
import type { ExecResult, Sandbox, SandboxError } from "../src/Sandbox/Sandboxes.ts"

export class ContractBroken extends Data.TaggedError("ContractBroken")<{
	readonly message: string
}> {}

type Checked = Effect.Effect<void, ContractBroken | SandboxError, Sandboxes>

export interface SandboxesClause {
	readonly name: string
	readonly check: (key: string) => Checked
}

const holds = (condition: boolean, message: string): Effect.Effect<void, ContractBroken> =>
	condition ? Effect.void : Effect.fail(new ContractBroken({ message }))

const exits = (result: ExecResult, exitCode: number, stdout: string, stderr = "") =>
	holds(
		result.exitCode === exitCode && result.stdout === stdout && result.stderr === stderr,
		`expected exit ${exitCode} with ${JSON.stringify({ stdout, stderr })}, got exit ${result.exitCode} with ${JSON.stringify({ stdout: result.stdout, stderr: result.stderr })}`,
	)

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
	left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])

const refused = <A>(call: Effect.Effect<A, SandboxError>, what: string) =>
	Effect.matchEffect(call, {
		onFailure: () => Effect.void,
		onSuccess: () => Effect.fail(new ContractBroken({ message: `${what} should fail` })),
	})

const inMachine = (key: string, use: (sandbox: Sandbox) => Checked): Checked =>
	Effect.gen(function* () {
		const sandboxes = yield* Sandboxes
		yield* Effect.ensuring(
			Effect.flatMap(sandboxes.open(key), use),
			Effect.ignore(sandboxes.remove(key)),
		)
	})

const patterned = (length: number): Uint8Array =>
	Uint8Array.from({ length }, (_, index) => (index * 31 + (index >> 8) * 7) % 256)

export const sandboxesContract: ReadonlyArray<SandboxesClause> = [
	{
		name: "opening a running machine again returns the same machine",
		check: (key) =>
			inMachine(key, (first) =>
				Effect.gen(function* () {
					yield* first.writeFile("/tmp/contract/mark", "kept")
					const again = yield* (yield* Sandboxes).open(key)
					yield* holds(
						again.incarnation === first.incarnation,
						`incarnation changed from ${first.incarnation} to ${again.incarnation}`,
					)
					yield* holds(
						(yield* again.readTextFile("/tmp/contract/mark")) === "kept",
						"the second handle does not see the first handle's file",
					)
				}),
			),
	},
	{
		name: "the next open after remove is a new, empty machine",
		check: (key) =>
			inMachine(key, (first) =>
				Effect.gen(function* () {
					const sandboxes = yield* Sandboxes
					yield* first.writeFile("/workspace/contract-mark", "gone")
					yield* sandboxes.remove(key)
					const next = yield* sandboxes.open(key)
					yield* holds(
						next.incarnation !== first.incarnation,
						`a replaced machine kept incarnation ${first.incarnation}`,
					)
					yield* exits(yield* next.exec(["test", "-e", "/workspace/contract-mark"]), 1, "")
				}),
			),
	},
	{
		name: "a handle to a removed machine fails instead of reaching its replacement",
		check: (key) =>
			inMachine(key, (first) =>
				Effect.gen(function* () {
					const sandboxes = yield* Sandboxes
					yield* sandboxes.remove(key)
					yield* sandboxes.open(key)
					yield* refused(first.exec(["true"]), "a command through the old handle")
					yield* refused(first.readFile("/etc/hostname"), "a read through the old handle")
					yield* refused(first.writeFile("/tmp/stale", "x"), "a write through the old handle")
				}),
			),
	},
	{
		name: "removing a machine that is not running succeeds",
		check: (key) =>
			Effect.gen(function* () {
				const sandboxes = yield* Sandboxes
				yield* sandboxes.remove(key)
				yield* sandboxes.remove(key)
			}),
	},
	{
		name: "files are written and read back byte for byte, creating their directories",
		check: (key) =>
			inMachine(key, (sandbox) =>
				Effect.gen(function* () {
					const everyByte = Uint8Array.from({ length: 256 }, (_, index) => index)
					yield* sandbox.writeFile("/tmp/contract/a/b/every-byte", everyByte)
					yield* holds(
						sameBytes(yield* sandbox.readFile("/tmp/contract/a/b/every-byte"), everyByte),
						"every byte value did not round-trip",
					)
					const large = patterned(3 * 1024 * 1024 + 17)
					yield* sandbox.writeFile("/tmp/contract/large", large)
					yield* holds(
						sameBytes(yield* sandbox.readFile("/tmp/contract/large"), large),
						"a 3 MiB file did not round-trip",
					)
					yield* sandbox.writeFile("/tmp/contract/large", "short")
					yield* holds(
						(yield* sandbox.readTextFile("/tmp/contract/large")) === "short",
						"overwriting with shorter content left the old tail",
					)
					yield* sandbox.writeFile("/tmp/contract/empty", new Uint8Array())
					yield* holds(
						(yield* sandbox.readFile("/tmp/contract/empty")).byteLength === 0,
						"an empty file was not empty",
					)
					const text = "héllo ☃ \u{1F600}\n"
					yield* sandbox.writeFile("/tmp/contract/text", text)
					yield* holds(
						(yield* sandbox.readTextFile("/tmp/contract/text")) === text,
						"UTF-8 text did not round-trip",
					)
				}),
			),
	},
	{
		name: "reading a missing file and writing over a directory fail",
		check: (key) =>
			inMachine(key, (sandbox) =>
				Effect.gen(function* () {
					yield* refused(sandbox.readFile("/tmp/contract/missing"), "reading a missing file")
					yield* sandbox.writeFile("/tmp/contract/dir/inside", "x")
					yield* refused(sandbox.writeFile("/tmp/contract/dir", "x"), "writing over a directory")
				}),
			),
	},
	{
		name: "a command string runs through a shell and an argument list does not",
		check: (key) =>
			inMachine(key, (sandbox) =>
				Effect.gen(function* () {
					yield* exits(yield* sandbox.exec("echo $((1 + 2)) | tr 3 4"), 0, "4\n")
					yield* exits(yield* sandbox.exec(["echo", "$((1 + 2))", "|", "x"]), 0, "$((1 + 2)) | x\n")
				}),
			),
	},
	{
		name: "a command reports its exit code, standard output and standard error apart",
		check: (key) =>
			inMachine(key, (sandbox) =>
				Effect.gen(function* () {
					yield* exits(yield* sandbox.exec("echo out; echo err >&2; exit 7"), 7, "out\n", "err\n")
					yield* exits(yield* sandbox.exec(["false"]), 1, "")
				}),
			),
	},
	{
		name: "a command runs in the asked directory, with the asked environment and input",
		check: (key) =>
			inMachine(key, (sandbox) =>
				Effect.gen(function* () {
					yield* sandbox.writeFile("/tmp/contract/cwd/.keep", "")
					yield* exits(
						yield* sandbox.exec(String.raw`pwd; printf "%s\n" "$CONTRACT_VALUE"`, {
							cwd: "/tmp/contract/cwd",
							env: { CONTRACT_VALUE: "a b'c" },
						}),
						0,
						"/tmp/contract/cwd\na b'c\n",
					)
					yield* exits(yield* sandbox.exec(["cat"], { stdin: "from stdin\n" }), 0, "from stdin\n")
					const bytes = patterned(70_000)
					yield* exits(
						yield* sandbox.exec(["wc", "-c"], { stdin: bytes }),
						0,
						`${bytes.byteLength}\n`,
					)
				}),
			),
	},
	{
		name: `a command past its timeout is stopped with exit ${TIMED_OUT}`,
		check: (key) =>
			inMachine(key, (sandbox) =>
				Effect.gen(function* () {
					const [took, result] = yield* Effect.timed(
						sandbox.exec(["sleep", "60"], { timeout: "2 seconds" }),
					)
					yield* holds(
						result.exitCode === TIMED_OUT,
						`a timed-out command exited ${result.exitCode}, not ${TIMED_OUT}`,
					)
					yield* holds(
						Duration.isLessThan(took, Duration.seconds(30)),
						`a 2 second timeout took ${Duration.format(took)}`,
					)
					yield* exits(yield* sandbox.exec(["echo", "after"]), 0, "after\n")
				}),
			),
	},
]
