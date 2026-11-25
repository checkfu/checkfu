export const CLIENT_EVENT_ID_MAX_LENGTH = 128

export const CLIENT_EVENT_ID_MESSAGE = `must be 1 to ${CLIENT_EVENT_ID_MAX_LENGTH} characters with no leading or trailing whitespace`

export const isClientEventId = (value: string): boolean =>
	value.length >= 1 && value.length <= CLIENT_EVENT_ID_MAX_LENGTH && value.trim() === value
