/**
 * Vault items in Code Mode. A program never gets a value. It gets a reference, a
 * short text such as `⟦vault:github/password⟧`. OpenBot puts the value in place of
 * the reference only when it sends an App tool call that the item allows, after the
 * program gave the call away. The App result goes through `redact` before the
 * program or the model sees it.
 */
import type { VaultsApi } from "@openbot-build/api"
import { Client } from "@openbot-build/protocol"
import { Effect, Predicate, Result, Schema } from "effect"
import type { Binding } from "../apps/Bindings.ts"
import type { Usable, Vaults } from "./Vaults.ts"

/** An item with the name that programs use, such as `github`. */
export interface Entry {
	readonly alias: string
	readonly usable: Usable
}

/**
 * Gives each item a name for programs. Two items with the same name in two Vaults
 * get `_2`, `_3`. The order is by item ID, so a new run gets the same names.
 */
export const aliases = (
	usable: ReadonlyArray<Usable>,
): ReadonlyArray<Entry> => {
	let named: ReadonlyArray<Entry> = []
	for (const entry of usable.toSorted((a, b) =>
		a.item.id.localeCompare(b.item.id),
	)) {
		let alias = entry.item.name
		for (let n = 2; named.some((other) => other.alias === alias); n++)
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
		: Array.isArray(value)
			? value.flatMap(strings)
			: Predicate.isObject(value)
				? Object.values(value).flatMap(strings)
				: []

/** Every reference in the string values of the arguments, once each. */
export const find = (args: Schema.Json): ReadonlyArray<Reference> => {
	const found = new Map<string, Reference>()
	for (const text of strings(args))
		for (const match of text.matchAll(pattern))
			found.set(match[1]! + "/" + match[2]!, {
				alias: match[1]!,
				field: match[2]!,
			})
	return [...found.values()]
}

/** Puts each value in place of its reference. `values` has `<alias>/<field>` keys. */
const substitute = (
	value: unknown,
	values: ReadonlyMap<string, string>,
): unknown => {
	if (Predicate.isString(value))
		return value.replace(
			pattern,
			(text, alias: string, field: string) =>
				values.get(alias + "/" + field) ?? text,
		)
	if (Array.isArray(value))
		return value.map((entry) => substitute(entry, values))
	if (Predicate.isObject(value))
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				substitute(entry, values),
			]),
		)
	return value
}

/** Values shorter than this are not taken out of results, or every short word could go. */
export const shortest = 4

/** The forms in which an App may give a value back. */
const formsOf = (value: string): ReadonlyArray<string> => {
	const bytes = Buffer.from(value, "utf8")
	const base64 = bytes.toString("base64")
	const forms = [
		value,
		base64,
		base64.replace(/=+$/, ""),
		bytes.toString("base64url"),
		bytes.toString("hex"),
		bytes.toString("hex").toUpperCase(),
		encodeURIComponent(value),
		JSON.stringify(value).slice(1, -1),
	]
	// The longest first, so a short form does not break a longer one.
	return [...new Set(forms)]
		.filter((form) => form.length >= shortest)
		.toSorted((a, b) => b.length - a.length)
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
): string => {
	let result = text
	for (const secret of secrets)
		for (const form of formsOf(secret.value))
			result = result.split(form).join("⟦hidden:" + secret.key + "⟧")
	return result
}

/** Takes the values out of every string in a JSON value, keys too. */
export const redact = (
	value: unknown,
	secrets: ReadonlyArray<Secret>,
): unknown => {
	if (secrets.length === 0) return value
	if (Predicate.isString(value)) return redactText(value, secrets)
	if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets))
	if (Predicate.isObject(value))
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				redactText(key, secrets),
				redact(entry, secrets),
			]),
		)
	return value
}

/** True when the item lets its values go to this App tool. */
export const allows = (
	exits: ReadonlyArray<VaultsApi.VaultExit>,
	source: Binding["source"],
) =>
	exits.some(
		(exit) =>
			exit._tag === "App" &&
			exit.connection === source.connectionId &&
			(exit.tool === null || exit.tool === source.name),
	)

/** Takes the values out of an App error. Errors without App data stay as they are. */
const redactError = (
	error: Client.Error | Schema.SchemaError,
	secrets: ReadonlyArray<Secret>,
): Client.Error => {
	if (Schema.isSchemaError(error))
		return Client.ClientError.make({
			reason: "Schema",
			issue: "The App call does not match the schema of the tool.",
		})
	switch (error._tag) {
		case "ToolFailure":
			return new Client.ToolFailure({
				result: redact(error.result, secrets) as typeof error.result,
			})
		case "ClientError":
			return Client.ClientError.make({
				reason: error.reason,
				issue: redactText(error.issue, secrets),
			})
		default:
			return error
	}
}

/**
 * Checks the references in the arguments of one App call. With no reference, the
 * binding stays as it is. Otherwise the result is a binding that reads the values
 * when it sends the call. It fails with the message for the program when a reference
 * is not allowed. Only App tools take references, never reads of resources or prompts.
 */
export const guard = (
	vaults: typeof Vaults.Service,
	organizationId: string,
	entries: ReadonlyArray<Entry>,
	binding: Binding,
	args: Schema.JsonObject,
): Result.Result<
	{ readonly binding: Binding; readonly references: number },
	string
> => {
	const references = find(args)
	if (references.length === 0) return Result.succeed({ binding, references: 0 })
	if (binding.source.kind !== "tool")
		return Result.fail(
			"Vault references can only go to App tools, not to resources or prompts.",
		)
	let wanted: ReadonlyArray<{
		readonly entry: Entry
		readonly fields: ReadonlyArray<string>
	}> = []
	for (const { alias, field } of references) {
		const entry = entries.find((entry) => entry.alias === alias)
		if (entry === undefined)
			return Result.fail(`There is no Vault item with the name ${alias}.`)
		if (!entry.usable.item.fields.includes(field))
			return Result.fail(`The Vault item ${alias} has no field ${field}.`)
		if (!allows(entry.usable.item.exits, binding.source))
			return Result.fail(
				`The Vault item ${alias} may not go to ${binding.source.connectionName} / ${binding.source.name}.`,
			)
		const other = wanted.find((want) => want.entry.alias === alias)
		wanted =
			other === undefined
				? [...wanted, { entry, fields: [field] }]
				: wanted.map((want) =>
						want === other
							? { ...want, fields: [...want.fields, field] }
							: want,
					)
	}
	const perform: Binding["perform"] = (input) =>
		Effect.gen(function* () {
			let values: ReadonlyArray<readonly [string, string]> = []
			for (const { entry, fields } of wanted) {
				const read = yield* vaults
					.reveal(organizationId, entry.usable.item.id, fields)
					.pipe(
						Effect.mapError((error) =>
							Client.ClientError.make({
								reason: "InputUnavailable",
								issue: `OpenBot could not read the Vault item ${entry.alias}: ${error.message}`,
							}),
						),
					)
				values = [
					...values,
					...[...read].map(
						([field, value]) => [entry.alias + "/" + field, value] as const,
					),
				]
			}
			const secrets = values.map(([key, value]) => ({ key, value }))
			const result = yield* binding
				.perform(substitute(input, new Map(values)))
				.pipe(Effect.mapError((error) => redactError(error, secrets)))
			// The answers to more input would come back on another path, where nothing takes the values out.
			if (result._tag === "InputRequired")
				return yield* Client.ClientError.make({
					reason: "InputUnavailable",
					issue:
						"The App asked for more input. A call with Vault values cannot do that.",
				})
			return {
				_tag: "Completed",
				result: redact(result.result, secrets),
			} as const
		})
	return Result.succeed({
		binding: { ...binding, perform },
		references: references.length,
	})
}

const comment = (text: string) => text.replaceAll("*/", "* /").slice(0, 500)

/** The TypeScript declaration of `vault`. It names the items and fields, and never a value. */
export const declarations = (entries: ReadonlyArray<Entry>): string => {
	if (entries.length === 0) return ""
	const items = entries.map(({ alias, usable }) => {
		const exits = usable.item.exits
			.map((exit) =>
				exit.tool === null
					? "every tool of connection " + exit.connection
					: exit.tool + " of connection " + exit.connection,
			)
			.join("; ")
		const fields = usable.item.fields
			.map(
				(field) => "\t\treadonly " + JSON.stringify(field) + ": VaultReference",
			)
			.join("\n")
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
${items.join("\n")}
}`
}
