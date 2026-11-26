export const SINGLE_PATH_SEGMENT_MESSAGE =
	'must be a single non-empty path segment (not "." or "..")'

export const isSinglePathSegment = (value: string): boolean =>
	value.length > 0 &&
	value !== "." &&
	value !== ".." &&
	!value.includes("/") &&
	!value.includes("\\")
