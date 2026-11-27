import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

/** Include every build-context file: image changes follow source changes, independently of npm. */
export const sandboxImageTag = async (directory: string): Promise<string> => {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true })
	const files: Array<string> = []
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			throw new Error("Sandbox build context must not contain symbolic links.")
		}
		if (entry.isFile()) {
			files.push(
				join(entry.parentPath, entry.name)
					.slice(directory.length + 1)
					.replaceAll("\\", "/"),
			)
		}
	}
	const hash = createHash("sha256")
	for (const name of files.sort()) {
		hash
			.update(`${name}\0`)
			.update(await readFile(join(directory, name)))
			.update("\0")
	}
	return `sha256-${hash.digest("hex")}`
}

if (import.meta.main) {
	process.stdout.write(
		`${await sandboxImageTag(new URL("../../api/src/Sandbox/image", import.meta.url).pathname)}\n`,
	)
}
