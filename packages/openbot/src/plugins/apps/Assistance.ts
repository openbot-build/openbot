import * as AppExecution from "../../apps/AssistanceResult.ts"

import { Identity } from "@openbot-build/domain"
import { Array as Arr, Effect, Schema, type JsonSchema } from "effect"
import { Tool } from "effect/ai"
import { Connections } from "../../apps/Connections.ts"
import type { Entry } from "./AppTools.ts"
import type { Error as IndexError, PublicIndex } from "../../apps/Index.ts"
import type * as Report from "../../errors/Report.ts"

/** The names of the assistance tools. A name gets a suffix when another tool already uses it. */
export const names = {
	search: "openbot_search_apps",
	details: "openbot_app_details",
	access: "openbot_app_access",
} as const

/** These tools read public descriptions or the owner's safe access state. They never add or authorize Apps. */
export const entries = (input: {
	readonly identity: typeof Identity.Service
	readonly occupied: ReadonlyArray<string>
	readonly index: typeof PublicIndex.Service
	readonly connections: typeof Connections.Service
	readonly report: Report.Report
}): ReadonlyArray<Entry> => {
	let occupied = input.occupied
	const entry = (
		name: string,
		description: string,
		parameters: JsonSchema.JsonSchema,
		handle: (input: unknown) => Effect.Effect<AppExecution.Assistance>,
	) => {
		let alias = name
		let salt = 0
		while (occupied.includes(alias)) alias = name + "_" + ++salt
		occupied = Arr.append(occupied, alias)
		return {
			tool: Tool.dynamic(alias, {
				description,
				parameters,
				success: AppExecution.ToolResult,
			}),
			handle,
		}
	}

	const unavailable =
		"App discovery or access information is unavailable. Existing connections that work do not depend on the Index."
	const failure = (
		reason: string,
		message: string = unavailable,
	): AppExecution.Assistance => ({
		_tag: "AppAssistanceFailed",
		reason,
		message,
	})
	/**
	 * A wrong input, an App that is not in the Index or a restricted App gives
	 * its own message, so the model can act on it. Only an Index that does not
	 * answer is unavailable.
	 */
	const indexFailure = (
		self: Effect.Effect<
			AppExecution.Assistance,
			Schema.SchemaError | IndexError
		>,
	) =>
		self.pipe(
			Effect.catchTags({
				SchemaError: (error) =>
					Effect.succeed(failure(error._tag, error.message)),
				IndexInputInvalid: (error) =>
					Effect.succeed(failure(error._tag, error.message)),
				IndexNotFound: (error) =>
					Effect.succeed(failure(error._tag, error.message)),
				IndexRestricted: (error) =>
					Effect.succeed(
						failure(
							error._tag,
							"This App is restricted: " + error.restriction.reason,
						),
					),
				IndexUnavailable: (error) =>
					input
						.report("The App Index is not available for App assistance.", error)
						.pipe(Effect.as(failure(error._tag))),
			}),
		)
	return [
		entry(
			names.search,
			"Search public App descriptions for a missing capability. Send only a short public description of the capability. Never send private documents, credentials or conversation history. Search does not add an App or approve an action.",
			{
				type: "object",
				properties: {
					query: { type: "string", maxLength: 200 },
					source: { type: "string" },
					cursor: { type: "string", maxLength: 8192 },
				},
				required: ["query"],
				additionalProperties: false,
			},
			(value) =>
				Schema.decodeUnknownEffect(
					Schema.Struct({
						query: Schema.String.check(Schema.isMaxLength(200)),
						source: Schema.optionalKey(Schema.String),
						cursor: Schema.optionalKey(
							Schema.String.check(Schema.isMaxLength(8192)),
						),
					}),
				)(value).pipe(
					Effect.flatMap((query) => input.index.search(query)),
					Effect.map((page): AppExecution.Assistance => ({
						_tag: "AppCandidates",
						page,
					})),
					indexFailure,
				),
		),
		entry(
			names.details,
			"Read the public details of a candidate App, and where it comes from, before the user chooses it. This gives no access.",
			{
				type: "object",
				properties: { cardUrl: { type: "string" }, source: { type: "string" } },
				required: ["cardUrl"],
				additionalProperties: false,
			},
			(value) =>
				Schema.decodeUnknownEffect(
					Schema.Struct({
						cardUrl: Schema.String,
						source: Schema.optionalKey(Schema.String),
					}),
				)(value).pipe(
					Effect.flatMap(({ cardUrl, source }) =>
						input.index.get(cardUrl, source),
					),
					Effect.map((app): AppExecution.Assistance => ({
						_tag: "AppDetails",
						app,
					})),
					indexFailure,
				),
		),
		entry(
			names.access,
			"Check this user's App account labels and what setup or authorization they need. Ask the user to choose an account when more than one could do the task. After adding or authorizing, the user must say in the same Chat that the work can go on.",
			{ type: "object", properties: {}, additionalProperties: false },
			() =>
				input.connections.listConnections.pipe(
					Effect.provideService(Identity, input.identity),
					Effect.map((connections): AppExecution.Assistance => ({
						_tag: "AppAccess",
						connections: Arr.map(connections, (connection) => ({
							id: connection.id,
							name: connection.name,
							cardUrl: connection.cardUrl,
							revision: connection.revision,
							enabled: connection.enabled,
							availability: connection.availability,
						})),
					})),
					Effect.catch((error) =>
						input
							.report("App access could not be read", error)
							.pipe(Effect.as(failure(error._tag))),
					),
				),
		),
	]
}
