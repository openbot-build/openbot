import type { Messages } from "./types.ts"

// Every file in this folder except this one and `types.ts` holds the text of
// one language. The file name is the URL path of the language, and `en` is
// English.
const files = import.meta.glob<{ default: Messages }>(
	["./*.ts", "!./index.ts", "!./types.ts"],
	{ eager: true },
)

/** The text of the home page for a URL path. Empty means English. */
export const messagesFor = (path: string): Messages => {
	const file = files[`./${path === "" ? "en" : path}.ts`]
	if (file === undefined) {
		throw new Error(`The home page has no text for the language "${path}".`)
	}
	return file.default
}
