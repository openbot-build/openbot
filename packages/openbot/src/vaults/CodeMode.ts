/**
 * Vault items in Code Mode. A program never gets a value. It gets a reference, a
 * short text such as `⟦vault:github/password⟧`. OpenBot puts the value in place of
 * the reference only when it sends an App tool call that the item allows, after the
 * program gave the call away. The App result goes through `redact` before the
 * program or the model sees it.
 */
import type { VaultsApi } from "@openbot-build/api"
import { Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Effect,
	HashMap,
	Option,
	Order,
	pipe,
	Predicate,
	Record as Rec,
	Result,
	Schema,
	String as Str,
} from "effect"
import { Base64, Base64Url, Hex } from "effect/encoding"
import type { Binding } from "../apps/Bindings.ts"
import type { Usable, Vaults } from "./Vaults.ts"

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
const substitute = (
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
	exits: ReadonlyArray<VaultsApi.VaultExit>,
	source: Binding["source"],
) =>
	Arr.some(
		exits,
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
		case "ToolFailure": {
			// The redaction can change keys and other text, so the result may no longer be a tool result.
			const result = redact(error.result, secrets)
			return Schema.is(Client.ToolFailure.fields.result)(result)
				? Client.ToolFailure.make({ result })
				: Client.ClientError.make({
						reason: "Schema",
						issue: "The App result could not be shown without its secrets.",
					})
		}
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
	const check = (
		reference: Reference,
	): Result.Result<
		{ readonly entry: Entry; readonly field: string },
		string
	> => {
		const { alias, field } = reference
		const found = Arr.findFirst(entries, (entry) => entry.alias === alias)
		if (Option.isNone(found))
			return Result.fail(`There is no Vault item with the name ${alias}.`)
		const entry = found.value
		if (!Arr.contains(entry.usable.item.fields, field))
			return Result.fail(`The Vault item ${alias} has no field ${field}.`)
		if (!allows(entry.usable.item.exits, binding.source))
			return Result.fail(
				`The Vault item ${alias} may not go to ${binding.source.connectionName} / ${binding.source.name}.`,
			)
		return Result.succeed({ entry, field })
	}
	const checked = Result.all(Arr.map(references, check))
	if (Result.isFailure(checked)) return Result.fail(checked.failure)
	// Aliases never look like numbers, so the record keeps the order of the references.
	const wanted = pipe(
		Arr.groupBy(checked.success, ({ entry }) => entry.alias),
		Rec.values,
		Arr.map((group) => ({
			entry: Arr.headNonEmpty(group).entry,
			fields: Arr.map(group, ({ field }) => field),
		})),
	)
	const perform: Binding["perform"] = (input) =>
		Effect.gen(function* () {
			const values = Arr.flatten(
				yield* Effect.forEach(wanted, ({ entry, fields }) =>
					vaults.reveal(organizationId, entry.usable.item.id, fields).pipe(
						Effect.tapError((error) =>
							Effect.logInfo(
								"OpenBot could not read a Vault item",
								Cause.fail(error),
							).pipe(Effect.annotateLogs({ item: entry.usable.item.id })),
						),
						Effect.mapError((error) =>
							Client.ClientError.make({
								reason: "InputUnavailable",
								issue: `OpenBot could not read the Vault item ${entry.alias}: ${error.message}`,
							}),
						),
						Effect.map((read) =>
							Arr.map(
								Arr.fromIterable(read),
								([field, value]) => [entry.alias + "/" + field, value] as const,
							),
						),
					),
				),
			)
			const secrets = Arr.map(values, ([key, value]) => ({ key, value }))
			const result = yield* binding
				.perform(substitute(input, HashMap.fromIterable(values)))
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
