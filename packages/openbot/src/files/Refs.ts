/**
 * A Chat names a file with an address like `openbot-file:file_123`, not with
 * its bytes. So the Items and the state of a Chat stay small, and the bytes
 * come from storage only at the time of a model call.
 */
export const scheme = "openbot-file:"

export const fileUrl = (id: string) => new URL(scheme + id)

/** The file ID of an address, or undefined when it does not name a file. */
export const fileIdOf = (url: URL): string | undefined =>
	url.protocol === scheme && url.pathname !== "" ? url.pathname : undefined

const pattern = /openbot-file:([A-Za-z0-9_-]+)/g

/** The IDs of the files that a stored Item names, each one time. */
export const fileIdsIn = (json: string): ReadonlyArray<string> => [
	...new Set(Array.from(json.matchAll(pattern), (match) => match[1]!)),
]
