import * as ChannelAdmission from "./ChannelAdmission.ts"
import {
	Authorization,
	Caller,
	Channels as Domain,
	Execution,
	Version,
} from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
} from "effect"
import { Base64Url } from "effect/encoding"
import * as Check from "../authorization/Check.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import { Bots } from "../bots/Bots.ts"
import * as Db from "../database/Database.ts"
import { channels as rows } from "../database/Schema.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey, segment } from "../audit/Resources.ts"
import * as Failures from "../errors/Failures.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"
import type { End } from "../execution/Program.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import { Channels, Credentials } from "./Channels.ts"
import { fromInput } from "./ChannelInput.ts"

export const workflowName = "openbot.channel-configuration"
export const Create = Schema.Struct({
	name: Schema.String,
	bot: Domain.Channel.fields.bot,
	credentials: Domain.CredentialsInput,
	linkPath: Schema.optionalKey(Schema.String),
	enabled: Schema.optionalKey(Schema.Boolean),
})
export const Update = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(Schema.String),
	bot: Schema.optionalKey(Domain.Channel.fields.bot),
	credentials: Schema.optionalKey(Domain.CredentialsInput),
	linkPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
	enabled: Schema.optionalKey(Schema.Boolean),
})
const Input = Schema.Struct({
	channel: Domain.Channel,
	credentials: Credentials,
	webhookUrl: Schema.String,
	predecessor: Schema.NullOr(
		Schema.Struct({ namespace: Schema.String, id: Execution.Id }),
	),
	secret: Schema.NullOr(Schema.RedactedFromValue(Schema.String)),
})
const sameCaller = Schema.toEquivalence(Caller)
const make = Effect.gen(function* () {
	const store = yield* Store
	const admit = yield* ChannelAdmission.make
	const channels = yield* Channels
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	const checks = yield* Check.make
	const bots = yield* Bots
	const audit = yield* AuditLog
	const settings = yield* Settings
	const found = (caller: Caller, id: string) =>
		channels.get(caller.organizationId, id).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(Domain.ChannelNotFound.make({ id })),
					onSome: Effect.succeed,
				}),
			),
		)
	const check = (caller: Caller, id?: string) =>
		checks
			.check(
				caller,
				id === undefined
					? {
							action: "write",
							kind: "Channel",
							within: ($) => $.eq("organizationId", caller.organizationId),
						}
					: {
							action: "write",
							resource: Authorization.Channel.make({
								organizationId: caller.organizationId,
								id,
							}),
						},
			)
			.pipe(
				Effect.catchTags({
					Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
					Pending: () => Effect.fail(Execution.Forbidden.make({})),
				}),
				storage,
			)
	const checkBot = (caller: Caller, id: typeof Create.Type.bot) =>
		bots.access(caller, id, "delegate").pipe(
			Effect.flatMap((bot) =>
				bot.owner._tag === "Organization" && !bot.archived
					? Effect.void
					: Effect.fail(
							Domain.ChannelInvalid.make({
								message: "The Channel needs an active shared Bot.",
							}),
						),
			),
			Effect.catchTags({
				BotNotFound: () =>
					Effect.fail(
						Domain.ChannelInvalid.make({
							message: "The Bot is not available.",
						}),
					),
				BotConflict: () => Effect.fail(Execution.Forbidden.make({})),
				BotInvalid: () => Effect.fail(Execution.Forbidden.make({})),
				BotStorageUnavailable: (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
			}),
		)
	const load = (key: Key) =>
		Effect.gen(function* () {
			const execution = yield* store.loadMember(key)
			const input = yield* Schema.decodeUnknownEffect(Input)(execution.input)
			if (
				execution.workflow !== workflowName ||
				execution.record.resource.kind !== "ChannelConfiguration" ||
				execution.record.resource.id !== input.channel.id
			)
				return yield* Execution.Forbidden.make({})
			return { execution, input }
		}).pipe(storage)
	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const saved = yield* load(key)
			if (
				actor.organizationId !== saved.execution.identity.owner.organizationId
			)
				return yield* Execution.Forbidden.make({})
			if (mode === "advance" || mode === "replay") {
				if (!sameCaller(actor, saved.execution.identity.actor))
					return yield* Execution.Forbidden.make({})
				yield* admit(actor.organizationId, saved.input.channel.id, false)
				yield* found(actor, saved.input.channel.id)
				yield* check(actor, saved.input.channel.id)
				yield* checkBot(actor, saved.input.channel.bot)
			} else if (mode === "read")
				yield* checks.check(actor, {
					action: "read",
					resource: Authorization.Channel.make({
						organizationId: actor.organizationId,
						id: saved.input.channel.id,
					}),
				})
			else yield* check(actor, saved.input.channel.id)
		}).pipe(
			Effect.catchTags({
				ChannelNotFound: () => Effect.fail(Execution.Forbidden.make({})),
				ChannelConflict: () => Effect.fail(Execution.Forbidden.make({})),
				ChannelInvalid: () => Effect.fail(Execution.Forbidden.make({})),
				Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
				Pending: () => Effect.fail(Execution.Forbidden.make({})),
			}),
			storage,
		)
	const accept = (
		caller: Caller,
		commandKey: Execution.CommandKey,
		command:
			| { readonly _tag: "Create"; readonly input: typeof Create.Type }
			| {
					readonly _tag: "Update"
					readonly id: string
					readonly input: typeof Update.Type
			  }
			| {
					readonly _tag: "Secret"
					readonly id: string
					readonly expectedVersion: number
			  },
	) =>
		Effect.gen(function* () {
			yield* check(caller, command._tag === "Create" ? undefined : command.id)
			const namespace = ownerKey(caller)
			const body =
				command._tag === "Create"
					? {
							_tag: command._tag,
							input: yield* Schema.encodeEffect(Schema.toCodecJson(Create))(
								command.input,
							),
						}
					: command._tag === "Update"
						? {
								_tag: command._tag,
								id: command.id,
								input: yield* Schema.encodeEffect(Schema.toCodecJson(Update))(
									command.input,
								),
							}
						: command
			const receipt = yield* store.accept(
				namespace,
				commandKey,
				{
					actor: caller,
					body: {
						caller: yield* Schema.encodeEffect(Schema.toCodecJson(Caller))(
							caller,
						),
						command: body,
					},
				},
				(create) =>
					Effect.gen(function* () {
						const origin = yield* Platform.publicOriginOr(settings, () =>
							Domain.ChannelsUnavailable.make({}),
						)
						if (command._tag !== "Create")
							yield* admit(caller.organizationId, command.id, false)
						const previous =
							command._tag === "Create"
								? null
								: yield* found(caller, command.id)
						if (
							previous !== null &&
							previous.version !==
								(command._tag === "Secret"
									? command.expectedVersion
									: command._tag === "Update"
										? command.input.expectedVersion
										: previous.version)
						)
							return yield* Domain.ChannelConflict.make({
								version: previous.version,
							})
						let secret: Redacted.Redacted<string> | null = null
						const credentials =
							command._tag === "Create"
								? yield* fromInput(crypto, command.input.credentials)
								: command._tag === "Update" &&
									  command.input.credentials !== undefined
									? yield* fromInput(
											crypto,
											command.input.credentials,
											(yield* channels.credentials(
												caller.organizationId,
												command.id,
											)).credentials,
										)
									: (yield* channels.credentials(
											caller.organizationId,
											command.id,
										)).credentials
						if (previous !== null && credentials.kind !== previous.kind)
							return yield* Domain.ChannelInvalid.make({
								message: "The kind of a Channel cannot change.",
							})
						if (command._tag === "Secret") {
							if (credentials.kind !== "custom")
								return yield* Domain.ChannelInvalid.make({
									message: "Only a custom Channel has a signing secret.",
								})
							secret = Redacted.make(
								"ocs_" +
									Base64Url.encode(
										yield* crypto.randomBytes(32).pipe(Effect.orDie),
									),
							)
						}
						const nextCredentials =
							secret !== null && credentials.kind === "custom"
								? { ...credentials, secret }
								: credentials
						const bot =
							command._tag === "Create"
								? command.input.bot
								: command._tag === "Update"
									? (command.input.bot ?? previous?.bot)
									: previous?.bot
						if (bot === undefined) return yield* Execution.Forbidden.make({})
						yield* checkBot(caller, bot)
						const channel =
							command._tag === "Create"
								? yield* channels.create({
										caller,
										name: command.input.name,
										bot,
										credentials: nextCredentials,
										linkPath: command.input.linkPath ?? null,
										enabled: command.input.enabled ?? true,
									})
								: yield* channels.update(
										caller,
										command.id,
										command._tag === "Update"
											? command.input.expectedVersion
											: command.expectedVersion,
										{
											...(command._tag === "Update" ? command.input : {}),
											credentials: nextCredentials,
										},
									)
						const predecessor =
							previous?.executionId == null
								? null
								: yield* store.locate(
										previous.executionId,
										caller.organizationId,
									)
						const key = yield* create({
							workflow: workflowName,
							resource: { kind: "ChannelConfiguration", id: channel.id },
							identity: {
								owner: {
									organizationId: caller.organizationId,
									userId: caller.userId,
								},
								actor: caller,
							},
							input: yield* Schema.encodeEffect(Schema.toCodecJson(Input))({
								channel,
								credentials: nextCredentials,
								webhookUrl: `${origin}/v1/hooks/channels/${channel.id}`,
								predecessor,
								secret,
							}),
						})
						yield* db
							.update(rows)
							.set({ executionId: key.id })
							.where(
								and(
									eq(rows.organizationId, caller.organizationId),
									eq(rows.id, channel.id),
								),
							)
							.pipe(storage)
						yield* audit
							.record({
								organizationId: caller.organizationId,
								actor: caller,
								action:
									command._tag === "Create"
										? "channel.created"
										: command._tag === "Secret"
											? "channel.secret_changed"
											: "channel.updated",
								resource:
									organizationKey(caller.organizationId) +
									".channel." +
									segment(channel.id),
								details: { executionId: key.id, version: channel.version },
							})
							.pipe(
								Failures.replace(
									"The Channel audit entry could not be saved.",
									() => Domain.ChannelsUnavailable.make({}),
								),
							)
						return { executionId: key.id, start: true }
					}),
			)
			const saved = yield* load({ namespace, id: receipt.executionId })
			return {
				channel: { ...saved.input.channel, executionId: receipt.executionId },
				secret: saved.input.secret,
			}
		})
	const finish = (fence: Fence, end: End | { readonly status: "completed" }) =>
		end.status === "cancelled"
			? store.finishCancellation(fence, end.epoch).pipe(Effect.asVoid)
			: store.commit(fence, end, Effect.void)
	return {
		create: (
			caller: Caller,
			key: Execution.CommandKey,
			input: typeof Create.Type,
		) =>
			accept(caller, key, { _tag: "Create", input }).pipe(
				Effect.map((result) => result.channel),
			),
		update: (
			caller: Caller,
			key: Execution.CommandKey,
			id: string,
			input: typeof Update.Type,
		) =>
			accept(caller, key, { _tag: "Update", id, input }).pipe(
				Effect.map((result) => result.channel),
			),
		rotate: (
			caller: Caller,
			key: Execution.CommandKey,
			id: string,
			expectedVersion: number,
		) =>
			accept(caller, key, { _tag: "Secret", id, expectedVersion }).pipe(
				Effect.flatMap((result) =>
					result.secret === null
						? Effect.fail(
								Domain.ChannelInvalid.make({
									message: "The saved command has no signing secret.",
								}),
							)
						: Effect.succeed({
								channel: result.channel,
								secret: result.secret,
							}),
				),
			),
		load,
		authorize,
		finish,
	}
})
export class ChannelConfig extends Context.Service<
	ChannelConfig,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/channels/ChannelConfig") {}
export const layer = Layer.effect(ChannelConfig, make)
