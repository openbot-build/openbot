import { Array as Arr, Layer, Option, pipe, String as Str } from "effect"
import { Robots } from "./Robots.ts"

interface Rule {
	readonly allow: boolean
	readonly pattern: string
}
interface Group {
	readonly bots: ReadonlyArray<string>
	readonly rules: ReadonlyArray<Rule>
}

/** RFC 9309: keep parseable rules even when there are unrelated records or malformed lines. */
const groups = (text: string) => {
	let result: ReadonlyArray<Group> = []
	let group: Group | undefined
	let rulesStarted = false
	for (const line of pipe(
		text,
		Str.replace(/^\uFEFF/, ""),
		Str.split(/\r\n|\r|\n/),
	)) {
		const value = Str.trim(Arr.headNonEmpty(Str.split(line, "#")))
		const colon = pipe(value, Str.indexOf(":"))
		if (Option.isNone(colon)) continue
		const name = pipe(
			value,
			Str.slice(0, colon.value),
			Str.trim,
			Str.toLowerCase,
		)
		const field = pipe(value, Str.slice(colon.value + 1), Str.trim)
		if (name === "user-agent") {
			if (!/^(?:[a-z_-]+|\*)$/i.test(field)) continue
			if (group === undefined || rulesStarted) {
				if (group !== undefined) result = Arr.append(result, group)
				group = { bots: [], rules: [] }
				rulesStarted = false
			}
			group = {
				...group,
				bots: Arr.append(group.bots, Str.toLowerCase(field)),
			}
		} else if (
			(name === "allow" || name === "disallow") &&
			group !== undefined
		) {
			rulesStarted = true
			if (pipe(field, Str.startsWith("/")) || pipe(field, Str.startsWith("*")))
				group = {
					...group,
					rules: Arr.append(group.rules, {
						allow: name === "allow",
						pattern: field,
					}),
				}
		}
	}
	return group === undefined ? result : Arr.append(result, group)
}
const octets = (value: string, pattern: boolean) => {
	let result = ""
	for (let index = 0; index < value.length; index++) {
		const part = value[index]
		if (part === undefined) continue
		const escape = pipe(value, Str.slice(index + 1, index + 3))
		if (part === "%" && /^[a-f\d]{2}$/i.test(escape)) {
			const hex = Str.toUpperCase(escape)
			const character = String.fromCharCode(Number.parseInt(hex, 16))
			result += /^[a-z\d_.~-]$/i.test(character) ? character : "%" + hex
			index += 2
		} else if (!pattern && (part === "*" || part === "$"))
			result += part === "*" ? "%2A" : "%24"
		else if (Option.exists(Str.codePointAt(part, 0), (point) => point > 127)) {
			const point = Str.codePointAt(value, index)
			if (Option.isSome(point)) {
				result += encodeURIComponent(String.fromCodePoint(point.value))
				if (point.value > 0xffff) index++
			}
		} else result += part
	}
	return result
}
const matches = (rule: string, path: string) => {
	const pattern = pipe(rule, Str.endsWith("$"))
		? pipe(rule, Str.slice(0, -1))
		: rule + "*"
	let cursor = 0
	let position = 0
	let star = -1
	let consumed = 0
	while (position < path.length) {
		if (pattern[cursor] === "*") {
			star = cursor++
			consumed = position
		} else if (pattern[cursor] === path[position]) {
			cursor++
			position++
		} else if (star >= 0) {
			cursor = star + 1
			position = ++consumed
		} else return false
	}
	while (pattern[cursor] === "*") cursor++
	return cursor === pattern.length
}
export const allowed = (options: {
	readonly text: string
	readonly productToken: string
	readonly url: string
}) => {
	const url = new URL(options.url)
	if (url.pathname === "/robots.txt") return true
	const parsed = groups(options.text)
	const token = Str.toLowerCase(options.productToken)
	const exact = Arr.filter(parsed, (group) => Arr.contains(group.bots, token))
	const selected = Arr.isReadonlyArrayNonEmpty(exact)
		? exact
		: Arr.filter(parsed, (group) => Arr.contains(group.bots, "*"))
	const path = octets(url.pathname + url.search, false)
	let length = -1
	let decision = true
	for (const rule of Arr.flatMap(selected, (group) => group.rules)) {
		const normalized = octets(rule.pattern, true)
		if (!matches(normalized, path)) continue
		const specificity = new TextEncoder().encode(
			pipe(normalized, Str.replaceAll("*", "")),
		).length
		if (specificity > length || (specificity === length && rule.allow)) {
			length = specificity
			decision = rule.allow
		}
	}
	return decision
}

export const layer = Layer.succeed(Robots, { allowed })
