import { Option } from "effect"

const words = (text: string) =>
	text.split(/\s+/).filter((word) => word.length > 0)

/**
 * Checks that `changed` is `original` with only new words added. Spaces and line breaks
 * may differ. It gives the added parts in order, or None when a word of `original` was
 * removed, changed or moved.
 */
export const insertions = (
	original: string,
	changed: string,
): Option.Option<ReadonlyArray<string>> => {
	const before = words(original)
	const after = words(changed)
	const added: Array<string> = []
	let current: Array<string> = []
	let next = 0
	// Each word of the original must come back in order. The first match is enough:
	// if the original is a subsequence at all, matching early still finds it.
	for (const word of after) {
		if (next < before.length && word === before[next]) {
			next += 1
			if (current.length > 0) added.push(current.join(" "))
			current = []
		} else current.push(word)
	}
	if (current.length > 0) added.push(current.join(" "))
	return next === before.length ? Option.some(added) : Option.none()
}
