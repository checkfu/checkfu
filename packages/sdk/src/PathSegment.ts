import { MAX_ARTIFACT_PATH_LENGTH } from "./Limits.ts"

export const SINGLE_PATH_SEGMENT_MESSAGE =
	'must be a single non-empty path segment (not "." or "..")'

export const isSinglePathSegment = (value: string): boolean =>
	value.length > 0 &&
	value !== "." &&
	value !== ".." &&
	!value.includes("/") &&
	!value.includes("\\")

const PATH_EXCLUDED = String.raw`/\\\u0000-\u001f\u007f-\u009f\u2028\u2029`
const PATH_SEGMENT = String.raw`(?:[^.${PATH_EXCLUDED}][^${PATH_EXCLUDED}]*|\.[^.${PATH_EXCLUDED}][^${PATH_EXCLUDED}]*|\.\.[^${PATH_EXCLUDED}]+)`
export const ARTIFACT_PATH = new RegExp(String.raw`^${PATH_SEGMENT}(?:/${PATH_SEGMENT})*$`, "u")

export const ARTIFACT_FILE_NAME = new RegExp(String.raw`^${PATH_SEGMENT}$`, "u")

export const MAX_MOUNT_PATH_LENGTH = 1024
export const FILE_MOUNT_ROOT = "/mnt/session/uploads"
export const MAX_FILE_MOUNT_RELATIVE_LENGTH = MAX_MOUNT_PATH_LENGTH - FILE_MOUNT_ROOT.length - 1

export const isRelativeFileMountPath = (value: string): boolean =>
	value.length <= MAX_FILE_MOUNT_RELATIVE_LENGTH &&
	Array.from(value).length <= MAX_ARTIFACT_PATH_LENGTH &&
	value.isWellFormed() &&
	ARTIFACT_PATH.test(value)
