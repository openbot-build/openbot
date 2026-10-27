import {
	type AppCalls,
	type ExecutionIdentity,
	Execution,
	executionCallers,
	Vaults as Domain,
} from "@openbot-build/domain"
import { Client } from "@openbot-build/protocol"
import { Array as Arr, Effect, HashMap, Option, Redacted, Schema } from "effect"
import * as References from "./CodeMode.ts"
import { Vaults } from "./Vaults.ts"

/** Only this phase holds values. Saved inputs hold fixed item IDs and field names. */
export const make = Effect.gen(function* () {
	const vaults = yield* Vaults
	const check = Effect.fn("AppSecrets.check")(function* (
		identity: ExecutionIdentity,
		source: AppCalls.Source,
		args: Schema.JsonObject,
		bindings: ReadonlyArray<Domain.ReferenceBinding>,
	) {
		const references = References.find(args)
		if (references.length === 0) return []
		if (source.kind !== "tool" || identity.botId === undefined)
			return yield* Execution.Forbidden.make({})
		const usable = yield* vaults.usable(
			identity.owner.organizationId,
			identity.botId,
		)
		return yield* Effect.forEach(references, ({ alias, field }) =>
			Effect.gen(function* () {
				const matches = Arr.filter(bindings, (entry) => entry.alias === alias)
				if (matches.length !== 1) return yield* Execution.Forbidden.make({})
				const binding = matches[0]!
				const current = Arr.findFirst(
					usable,
					(entry) => entry.item.id === binding.item,
				)
				if (
					Option.isNone(current) ||
					!Arr.contains(binding.fields, field) ||
					!Arr.contains(current.value.item.fields, field) ||
					!References.allows(current.value.item.exits, source)
				)
					return yield* Execution.Forbidden.make({})
				for (const caller of executionCallers(identity))
					yield* vaults
						.get(caller, current.value.item.vault, "use")
						.pipe(
							Effect.catchTag("VaultNotFound", () =>
								Effect.fail(Execution.Forbidden.make({})),
							),
						)
				return { alias, field, item: current.value.item }
			}),
		)
	})
	const prepare = Effect.fn("AppSecrets.prepare")(function* (
		identity: ExecutionIdentity,
		source: AppCalls.Source,
		args: Schema.JsonObject,
		bindings: ReadonlyArray<Domain.ReferenceBinding>,
	) {
		const read = check(identity, source, args, bindings)
		const wanted = yield* read
		const secretValues = yield* Effect.acquireRelease(
			Effect.forEach(wanted, ({ alias, field, item }) =>
				vaults.reveal(identity.owner.organizationId, item.id, [field]).pipe(
					Effect.flatMap((values) => {
						const value = values.get(field)
						return value === undefined
							? Effect.fail(Execution.Forbidden.make({}))
							: Effect.succeed({ key: alias + "/" + field, value })
					}),
				),
			).pipe(Effect.map(Redacted.make)),
			(values) =>
				Effect.sync(() => {
					Redacted.wipeUnsafe(values)
				}),
			{ interruptible: true },
		)
		// A provider read can take time. Check rights, item fields and exits again after it.
		const current = yield* read
		if (
			!Schema.toEquivalence(
				Schema.Array(
					Schema.Struct({
						alias: Schema.String,
						field: Schema.String,
						item: Domain.VaultItem,
					}),
				),
			)(wanted, current)
		)
			return yield* Execution.Forbidden.make({})
		const values = Redacted.value(secretValues)
		const arguments_ = yield* Effect.acquireRelease(
			Schema.decodeUnknownEffect(Schema.JsonObject)(
				References.substitute(
					args,
					HashMap.fromIterable(
						Arr.map(values, ({ key, value }) => [key, value] as const),
					),
				),
			).pipe(Effect.map(Redacted.make)),
			(value) =>
				Effect.sync(() => {
					Redacted.wipeUnsafe(value)
				}),
		)
		return {
			arguments: arguments_,
			result: (result: Client.OperationResult<unknown>) =>
				Effect.gen(function* () {
					if (wanted.length > 0 && result._tag === "InputRequired")
						return yield* Client.ClientError.make({
							reason: "InputUnavailable",
							issue: "An App call with Vault values cannot ask for more input.",
						})
					if (result._tag === "InputRequired") return result
					return {
						_tag: "Completed" as const,
						result: References.redact(
							result.result,
							Redacted.value(secretValues),
						),
					}
				}),
		}
	})
	return { check, prepare }
})
