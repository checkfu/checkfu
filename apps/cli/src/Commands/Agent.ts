import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import { usageError } from "../Errors.ts"
import { decodeDefinition, fileType, readSource } from "../Project/Source.ts"
import { renderOutput } from "../RootCommand.ts"

const infoCommand = Command.make("info", { file: Argument.String("file") }, ({ file }) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const absolute = path.resolve(file)
		if ((yield* fileType(absolute)) !== "File") {
			return yield* usageError(`${file}: expected an existing agent file.`)
		}
		const source = yield* readSource(absolute, file, "explicit", "agent")
		if (source === undefined) {
			return yield* usageError(`${file}: expected an agent definition.`)
		}
		const definition = yield* decodeDefinition(source.kind, source.body, file)
		yield* renderOutput(definition.body)
	}),
).pipe(
	Command.withDescription("Validate and print a local agent definition"),
	Command.withAlias("validate"),
)

export const agentCommand = Command.make("agent").pipe(
	Command.withDescription("Inspect agent source files"),
	Command.withSubcommands([infoCommand]),
)
