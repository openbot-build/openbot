/**
 * Vault items in Code Mode. A program never gets a value. It gets a reference, a
 * short text such as `⟦vault:github/password⟧`. OpenBot puts the value in place of
 * the reference only when it sends an App tool call that the item allows, after the
 * program gave the call away. The App result goes through `redact` before the
 * program or the model sees it.
 */
import type { AppCalls, Vaults as VaultsModel } from "@openbot-build/domain"
import {
	Array as Arr,
	HashMap,
	Option,
	Order,
	pipe,
	Predicate,
	Record as Rec,
	type Schema,
	String as Str,
} from "effect"
import { Base64, Base64Url, Hex } from "effect/encoding"
import type { Usable } from "./Vaults.ts"

/** An item with the name that programs use, such as `github`. */
export interface Entry {
	readonly alias: string
	readonly usable: Usable
}

const byItemId = Order.mapInput(
	Order.make((self: string, that: string) => Str.localeCompare(that)(self)),
	(usable: Usable) => usable.item.id,
)

/**
 * Gives each item a name for programs. Two items with the same name in two Vaults
 * get `_2`, `_3`. The order is by item ID, so a new run gets the same names.
 */
export const aliases = (
	usable: ReadonlyArray<Usable>,
): ReadonlyArray<Entry> => {
	let named: ReadonlyArray<Entry> = []
	for (const entry of Arr.sort(usable, byItemId)) {
		let alias = entry.item.name
		for (let n = 2; Arr.some(named, (other) => other.alias === alias); n++)
			alias = entry.item.name + "_" + n
		named = [...named, { alias, usable: entry }]
	}
	return named
}

/** The text that stands for one field of an item. */
export const reference = (alias: string, field: string) =>
	"⟦vault:" + alias + "/" + field + "⟧"

const pattern = /⟦vault:([a-z][a-z0-9_]*)\/([^/⟦⟧\u0000-\u001f]{1,64})⟧/g

export interface Reference {
	readonly alias: string
	readonly field: string
}

const strings = (value: unknown): ReadonlyArray<string> =>
	Predicate.isString(value)
		? [value]
		: Arr.isArray(value)
			? Arr.flatMap(value, strings)
			: Predicate.isObject(value)
				? Arr.flatMap(Rec.values(value), strings)
				: []

/** Every reference in the string values of the arguments, once each. */
export const find = (args: Schema.Json): ReadonlyArray<Reference> =>
	pipe(
		strings(args),
		Arr.flatMap((text) => Arr.fromIterable(Str.matchAll(pattern)(text))),
		// Both groups of the pattern must match, so a match always has them.
		Arr.map(([, alias, field]) => ({ alias: alias!, field: field! })),
		Arr.dedupeWith((a, b) => a.alias === b.alias && a.field === b.field),
	)

/** Puts each value in place of its reference. `values` has `<alias>/<field>` keys. */
export const substitute = (
	value: unknown,
	values: HashMap.HashMap<string, string>,
): unknown => {
	if (Predicate.isString(value))
		// @effect-diagnostics-next-line preferEffectString:off -- Str.replace takes no replacer function. The function keeps a "$" in a value as it is.
		return value.replace(pattern, (text, alias: string, field: string) =>
			Option.getOrElse(HashMap.get(values, alias + "/" + field), () => text),
		)
	if (Arr.isArray(value))
		return Arr.map(value, (entry) => substitute(entry, values))
	if (Predicate.isObject(value))
		return Rec.map(value, (entry) => substitute(entry, values))
	return value
}

/** Values shorter than this are not taken out of results, or every short word could go. */
export const shortest = 4

const longestFirst = Order.flip(
	Order.mapInput(Order.Number, (form: string) => form.length),
)

/** The forms in which an App may give a value back. */
const formsOf = (value: string): ReadonlyArray<string> => {
	const base64 = Base64.encode(value)
	const hex = Hex.encode(value)
	const forms = [
		value,
		base64,
		Str.replace(/=+$/, "")(base64),
		Base64Url.encode(value),
		hex,
		Str.toUpperCase(hex),
		encodeURIComponent(value),
		Str.slice(1, -1)(JSON.stringify(value)),
	]
	// The longest first, so a short form does not break a longer one.
	return pipe(
		Arr.dedupe(forms),
		Arr.filter((form) => form.length >= shortest),
		Arr.sort(longestFirst),
	)
}

export interface Secret {
	/** `<alias>/<field>`. */
	readonly key: string
	readonly value: string
}

/** Takes each value, and its common encodings, out of a text. */
export const redactText = (
	text: string,
	secrets: ReadonlyArray<Secret>,
): string =>
	Arr.reduce(secrets, text, (result, secret) =>
		Arr.reduce(formsOf(secret.value), result, (part, form) =>
			Arr.join(Str.split(part, form), "⟦hidden:" + secret.key + "⟧"),
		),
	)

/** Takes the values out of every string in a JSON value, keys too. */
export const redact = (
	value: unknown,
	secrets: ReadonlyArray<Secret>,
): unknown => {
	if (secrets.length === 0) return value
	if (Predicate.isString(value)) return redactText(value, secrets)
	if (Arr.isArray(value))
		return Arr.map(value, (entry) => redact(entry, secrets))
	if (Predicate.isObject(value))
		return Rec.fromEntries(
			Arr.map(
				Rec.toEntries(value),
				([key, entry]) =>
					[redactText(key, secrets), redact(entry, secrets)] as const,
			),
		)
	return value
}

/** True when the item lets its values go to this App tool. */
export const allows = (
	exits: ReadonlyArray<VaultsModel.VaultExit>,
	source: AppCalls.Source,
) =>
	Arr.some(
		exits,
		(exit) =>
			exit._tag === "App" &&
			exit.connection === source.connectionId &&
			(exit.tool === null || exit.tool === source.name),
	)

const comment = (text: string) =>
	pipe(text, Str.replaceAll("*/", "* /"), Str.slice(0, 500))

/** The TypeScript declaration of `vault`. It names the items and fields, and never a value. */
export const declarations = (entries: ReadonlyArray<Entry>): string => {
	if (entries.length === 0) return ""
	const items = Arr.map(entries, ({ alias, usable }) => {
		const exits = pipe(
			usable.item.exits,
			Arr.map((exit) =>
				exit.tool === null
					? "every tool of connection " + exit.connection
					: exit.tool + " of connection " + exit.connection,
			),
			Arr.join("; "),
		)
		const fields = pipe(
			usable.item.fields,
			Arr.map(
				(field) => "\t\treadonly " + JSON.stringify(field) + ": VaultReference",
			),
			Arr.join("\n"),
		)
		return (
			"\t/** " +
			comment(
				(usable.item.description === "" ? "" : usable.item.description + " ") +
					"From the Vault " +
					usable.vaultName +
					". It may go to: " +
					(exits === "" ? "nothing" : exits) +
					".",
			) +
			" */\n\t" +
			alias +
			": {\n" +
			fields +
			"\n\t}"
		)
	})
	return `/**
 * A reference to a secret, such as "⟦vault:github/password⟧". It is not the secret.
 * Put it in a string argument of an App tool call, alone or in a longer string, such as
 * \`"Bearer " + vault.github.token\`. OpenBot puts the secret in place of the reference
 * only when it sends the call, and only to the tools that the item allows. A call to
 * another tool throws an Error with name "VaultDenied". Changing the reference breaks it.
 * Secrets in App results come back as "⟦hidden:<item>/<field>⟧".
 */
type VaultReference = string
declare const vault: {
${Arr.join(items, "\n")}
}`
}
