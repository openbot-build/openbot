import { Array as EffectArray, Layer } from "effect"
import { Robots } from "./Robots.ts"

interface Rule {
	readonly allow: boolean
	readonly pattern: string
}
interface Group {
	readonly agents: ReadonlyArray<string>
	readonly rules: ReadonlyArray<Rule>
}

/** RFC 9309: keep parseable rules even when there are unrelated records or malformed lines. */
const groups = (text: string) => {
	let result: ReadonlyArray<Group> = []
	let group: Group | undefined
	let rulesStarted = false
	for (const line of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
		const value = line.split("#", 1)[0]?.trim() ?? ""
		const colon = value.indexOf(":")
		if (colon < 0) continue
		const name = value.slice(0, colon).trim().toLowerCase()
		const field = value.slice(colon + 1).trim()
		if (name === "user-agent") {
			if (!/^(?:[a-z_-]+|\*)$/i.test(field)) continue
			if (group === undefined || rulesStarted) {
				if (group !== undefined) result = EffectArray.append(result, group)
				group = { agents: [], rules: [] }
				rulesStarted = false
			}
			group = {
				...group,
				agents: EffectArray.append(group.agents, field.toLowerCase()),
			}
		} else if (
			(name === "allow" || name === "disallow") &&
			group !== undefined
		) {
			rulesStarted = true
			if (field.startsWith("/") || field.startsWith("*"))
				group = {
					...group,
					rules: EffectArray.append(group.rules, {
						allow: name === "allow",
						pattern: field,
					}),
				}
		}
	}
	return group === undefined ? result : EffectArray.append(result, group)
}
const octets = (value: string, pattern: boolean) => {
	let result = ""
	for (let index = 0; index < value.length; index++) {
		const part = value[index]
		if (part === undefined) continue
		if (
			part === "%" &&
			/^[a-f\d]{2}$/i.test(value.slice(index + 1, index + 3))
		) {
			const hex = value.slice(index + 1, index + 3).toUpperCase()
			const character = String.fromCharCode(Number.parseInt(hex, 16))
			result += /^[a-z\d_.~-]$/i.test(character) ? character : "%" + hex
			index += 2
		} else if (!pattern && (part === "*" || part === "$"))
			result += part === "*" ? "%2A" : "%24"
		else if (part.codePointAt(0)! > 127) {
			const point = value.codePointAt(index)
			if (point !== undefined) {
				result += encodeURIComponent(String.fromCodePoint(point))
				if (point > 0xffff) index++
			}
		} else result += part
	}
	return result
}
const matches = (rule: string, path: string) => {
	const pattern = rule.endsWith("$") ? rule.slice(0, -1) : rule + "*"
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
	const token = options.productToken.toLowerCase()
	const exact = parsed.filter((group) => group.agents.includes(token))
	const selected =
		exact.length > 0
			? exact
			: parsed.filter((group) => group.agents.includes("*"))
	const path = octets(url.pathname + url.search, false)
	let length = -1
	let decision = true
	for (const rule of selected.flatMap((group) => group.rules)) {
		const normalized = octets(rule.pattern, true)
		if (!matches(normalized, path)) continue
		const specificity = new TextEncoder().encode(
			normalized.replace(/\*/g, ""),
		).length
		if (specificity > length || (specificity === length && rule.allow)) {
			length = specificity
			decision = rule.allow
		}
	}
	return decision
}

export const layer = Layer.succeed(Robots, { allowed })
