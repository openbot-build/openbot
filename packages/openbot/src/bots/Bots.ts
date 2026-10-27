import type { Config } from "@openbot-build/core"
import { Bots as BotsApi } from "@openbot-build/domain"
import { type Authorization } from "@openbot-build/domain"
import { type Caller } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import * as Check from "../authorization/Check.ts"
import { botResource, rootOf } from "../authorization/Resources.ts"
import { BotRecords, type Keys } from "./BotRecords.ts"

type Bot = BotsApi.Bot
type BotId = BotsApi.BotId

export type Failure =
	| BotsApi.BotNotFound
	| BotsApi.BotConflict
	| BotsApi.BotInvalid
	| BotsApi.BotStorageUnavailable
	| Check.Errors

/** An action on a Bot, such as `read` or `delegate`. */
export type Action = (typeof Authorization.Bot.actions)[number]

/** The member that work is done for. */
export interface Subject {
	readonly organizationId: string
	readonly userId: string
}

/** The Bots of an organization. */
export class Bots extends Context.Service<
	Bots,
	{
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Bot>, BotsApi.BotStorageUnavailable>
		/**
		 * Reads a Bot and checks that the caller may do the action on it. A caller
		 * who may not read the Bot gets `BotNotFound`.
		 */
		readonly access: (
			caller: Caller,
			id: string,
			action: Action,
		) => Effect.Effect<Bot, Failure>
		readonly list: (
			caller: Caller,
			input: {
				readonly archived?: boolean
				readonly bot?: BotId
			},
		) => Effect.Effect<ReadonlyArray<Bot>, Failure>
		readonly create: (
			caller: Caller,
			input: BotsApi.CreateBotRequest,
		) => Effect.Effect<Bot, Failure>
		/**
		 * Makes a lasting Bot that another Bot owns. A Bot uses it with a tool.
		 * The capability gate checks it first, so it checks no permission itself.
		 */
		readonly createOwned: (
			organizationId: string,
			owner: Bot,
			input: {
				readonly name: string
				readonly role: string
				readonly instructions: string
				readonly model?: Config.Selection
			},
		) => Effect.Effect<Bot, BotsApi.BotStorageUnavailable>
		readonly update: (
			caller: Caller,
			id: string,
			input: BotsApi.UpdateBotRequest,
		) => Effect.Effect<Bot, Failure>
		/**
		 * Lets the caller use a shared Bot: it makes a linked Bot in the organization of the
		 * caller, and makes the caller a member of the shared Bot. A member keeps one linked
		 * Bot. When they already have one, it gives that one back.
		 */
		readonly link: (
			caller: Caller,
			source: { readonly organizationId: string; readonly bot: Bot },
		) => Effect.Effect<Bot, Failure>
		/** The people who use a shared Bot in their own organizations. */
		readonly members: (
			organizationId: string,
			bot: BotId,
		) => Effect.Effect<
			ReadonlyArray<BotsApi.BotMember>,
			BotsApi.BotStorageUnavailable
		>
		/** Takes a person off a shared Bot. Their linked Bot stops working. */
		readonly removeMember: (
			organizationId: string,
			bot: BotId,
			userId: string,
		) => Effect.Effect<boolean, BotsApi.BotStorageUnavailable>
		/**
		 * The deciders of a Bot: its owner chain from the top, ending with the Bot.
		 * The top is a Bot that a member or the organization owns. Archived Bots are left out.
		 * `subject` is the member who works with the Bot now.
		 */
		readonly ownerChain: (
			subject: Subject,
			bot: Bot,
		) => Effect.Effect<ReadonlyArray<BotId>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/bots/Bots") {}

/** A person who uses a shared Bot, with the shared Bot. */
const Membership = Schema.Struct({
	bot: BotsApi.BotId,
	...BotsApi.BotMember.fields,
})

/** The status key of a Bot record. */
const RecordStatus = Schema.Literals(["active", "archived"])
type RecordStatus = typeof RecordStatus.Type

/** The owner and scope keys of a Bot record. */
const keys = (organizationId: string, bot: Bot): Keys<RecordStatus> => ({
	organizationId,
	id: bot.id,
	owner: rootOf(bot.owner) ?? "",
	scope: bot.owner._tag === "Bot" ? bot.owner.bot : "",
	status: bot.archived ? "archived" : "active",
})

export const make: Effect.Effect<
	typeof Bots.Service,
	never,
	BotRecords | Crypto.Crypto | Check.Services
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const crypto = yield* Crypto.Crypto
	const { check, filter, guard } = yield* Check.make
	const newId = crypto.randomUUIDv4({ format: "bytes" }).pipe(
		// A platform without secure random numbers is broken.
		Effect.orDie,
		Effect.map((uuid) => BotsApi.BotId.make("bot_" + Hex.encode(uuid))),
	)
	const bots = records.collection("bot", BotsApi.Bot, RecordStatus)
	/** The members of shared Bots, kept in the organization of each shared Bot. */
	const memberships = records.collection("bot_member", Membership)
	const membershipId = (bot: BotId, userId: string) =>
		bot + "/" + encodeURIComponent(userId)
	const put = (organizationId: string, bot: Bot) =>
		bots.put(keys(organizationId, bot), bot).pipe(Effect.as(bot))
	/**
	 * A linked Bot takes its name, role, instructions and model from its source.
	 * It works only while the source is not archived and its owner is still a member
	 * of the source. Otherwise it does not exist.
	 */
	const resolve = (bot: Bot) =>
		Effect.gen(function* () {
			const source = bot.source
			if (source === undefined) return Option.some(bot)
			const found = yield* bots.find(source.organizationId, source.bot)
			const owner = rootOf(bot.owner)
			const member =
				owner === null
					? Option.none()
					: yield* memberships.find(
							source.organizationId,
							membershipId(source.bot, owner),
						)
			if (
				Option.isNone(found) ||
				found.value.archived ||
				Option.isNone(member) ||
				member.value.linked !== bot.id
			)
				return Option.none<Bot>()
			const { model: _model, ...rest } = bot
			return Option.some<Bot>({
				...rest,
				name: found.value.name,
				role: found.value.role,
				instructions: found.value.instructions,
				...(found.value.model === undefined
					? {}
					: { model: found.value.model }),
			})
		})
	const resolveAll = (list: ReadonlyArray<Bot>) =>
		Effect.forEach(list, resolve).pipe(Effect.map(Arr.getSomes))
	const find: typeof Bots.Service.find = (organizationId, id) =>
		bots.find(organizationId, id).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.succeedNone,
					onSome: resolve,
				}),
			),
		)
	const resourceOf = (caller: Caller, bot: Bot) =>
		botResource({ ...bot, organizationId: caller.organizationId })
	const access: typeof Bots.Service.access = (caller, id, action) =>
		Effect.gen(function* () {
			const bot = yield* find(caller.organizationId, id).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.fail(BotsApi.BotNotFound.make({ bot: id })),
						onSome: Effect.succeed,
					}),
				),
			)
			// A caller who cannot read the Bot does not learn that it exists.
			yield* guard(
				caller,
				{ action, resource: resourceOf(caller, bot) },
				{
					hide: () => BotsApi.BotNotFound.make({ bot: id }),
				},
			)
			return bot
		})
	/** Reads a Bot, checks its revision and writes the change. The caller holds the lock of the Bot. */
	const change = (
		caller: Caller,
		id: string,
		action: Action,
		expected: number,
		update: (bot: Bot, now: number) => Effect.Effect<Bot, Failure>,
	) =>
		Effect.gen(function* () {
			const bot = yield* access(caller, id, action)
			if (bot.revision !== expected)
				return yield* BotsApi.BotConflict.make({
					message: "The Bot changed. Read it again and retry.",
				})
			const now = yield* Clock.currentTimeMillis
			const next = yield* update(bot, now)
			return yield* put(caller.organizationId, {
				...next,
				revision: bot.revision + 1,
				updatedAt: now,
			})
		})
	const visible = (caller: Caller, list: ReadonlyArray<Bot>) =>
		Effect.map(filter(caller, { action: "read", kind: "Bot" }), (readable) =>
			Arr.filter(list, (bot) =>
				Check.matches(readable, resourceOf(caller, bot)),
			),
		)
	/**
	 * Archives Bots and every Bot below them in the owner tree. It runs in the
	 * transaction of the top Bot, and takes the lock of each Bot below before it
	 * reads and writes it, so a change of that Bot at the same time is not lost.
	 * The locks go from the top down, so two archives cannot block each other for ever.
	 */
	const archiveTree = (
		organizationId: string,
		list: ReadonlyArray<Bot>,
		now: number,
	): Effect.Effect<ReadonlyArray<Bot>, BotsApi.BotStorageUnavailable> =>
		Effect.gen(function* () {
			if (list.length === 0) return []
			const archived = yield* Effect.forEach(list, (bot) =>
				bot.archived
					? Effect.succeed(bot)
					: put(organizationId, {
							...bot,
							archived: true,
							revision: bot.revision + 1,
							updatedAt: now,
						}),
			)
			const below = yield* Effect.forEach(list, (bot) =>
				bots.list(organizationId, { scope: bot.id }),
			)
			// One at a time, so the locks come in a fixed order.
			const owned = yield* Effect.forEach(
				Arr.filter(Arr.flatten(below), (bot) => bot.owner._tag === "Bot"),
				(child) =>
					records
						.lock("bot:" + organizationId + ":" + child.id)
						.pipe(Effect.andThen(bots.find(organizationId, child.id))),
			)
			return [
				...archived,
				...(yield* archiveTree(organizationId, Arr.getSomes(owned), now)),
			]
		})
	/** The Bot that decides above a Bot, or none for a top Bot. Above it is the person. */
	const above = (organizationId: string, bot: Bot) => {
		switch (bot.owner._tag) {
			case "Bot":
				return find(organizationId, bot.owner.bot)
			case "Member":
			case "Organization":
				return Effect.succeedNone
		}
	}
	const climb = (
		subject: Subject,
		from: Bot,
		chain: ReadonlyArray<BotId>,
		seen: ReadonlyArray<BotId>,
	): Effect.Effect<ReadonlyArray<BotId>, BotsApi.BotStorageUnavailable> =>
		above(subject.organizationId, from).pipe(
			Effect.flatMap((next) => {
				if (Option.isNone(next)) return Effect.succeed(chain)
				// A loop can only come from broken records. It must not hang the work.
				if (seen.includes(next.value.id))
					return Effect.logWarning(
						"The owner chain of a Bot has a loop. Its records are broken.",
					).pipe(
						Effect.annotateLogs({ bot: from.id, loop: next.value.id }),
						Effect.as(chain),
					)
				const bot = next.value
				return climb(subject, bot, bot.archived ? chain : [bot.id, ...chain], [
					...seen,
					bot.id,
				])
			}),
		)
	/** The owner of a Bot that the Bot `owner` owns. */
	const ownerFor = (owner: Bot): Bot["owner"] => ({
		_tag: "Bot",
		bot: owner.id,
		userId: rootOf(owner.owner),
	})
	const fresh = (input: {
		readonly owner: Bot["owner"]
		readonly name: string
		readonly role: string
		readonly instructions: string
		readonly model?: Config.Selection
		readonly planApproval?: BotsApi.Bot["planApproval"]
		readonly now: number
	}) =>
		Effect.map(newId, (id): Bot => ({
			id,
			owner: input.owner,
			name: input.name,
			role: input.role,
			instructions: input.instructions,
			...(input.model === undefined ? {} : { model: input.model }),
			...(input.planApproval === undefined
				? {}
				: { planApproval: input.planApproval }),
			archived: false,
			revision: 0,
			createdAt: input.now,
			updatedAt: input.now,
		}))
	const writable = (caller: Caller, bot: Bot) =>
		check(caller, { action: "write", resource: resourceOf(caller, bot) })
	return Bots.of({
		find,
		access,
		list: (caller, input) =>
			Effect.gen(function* () {
				if (input.bot !== undefined) {
					yield* access(caller, input.bot, "read")
					const below = yield* bots
						.list(caller.organizationId, { scope: input.bot })
						.pipe(Effect.flatMap(resolveAll))
					return Arr.filter(
						yield* visible(
							caller,
							Arr.filter(below, (bot) => bot.owner._tag === "Bot"),
						),
						(bot) =>
							input.archived === undefined || bot.archived === input.archived,
					)
				}
				const own = yield* bots
					.list(caller.organizationId, { owner: caller.userId })
					.pipe(Effect.flatMap(resolveAll))
				const shared = yield* bots.list(caller.organizationId, { owner: "" })
				const all = yield* visible(caller, [...own, ...shared])
				return Arr.filter(
					all,
					(bot) =>
						input.archived === undefined || bot.archived === input.archived,
				)
			}),
		create: (caller, input) =>
			Effect.gen(function* () {
				if (input.shared === true && input.bot !== undefined)
					return yield* BotsApi.BotInvalid.make({
						message: "A shared Bot cannot have an owner Bot.",
					})
				const owner: Bot["owner"] =
					input.bot !== undefined
						? ownerFor(yield* access(caller, input.bot, "read"))
						: input.shared === true
							? { _tag: "Organization" }
							: { _tag: "Member", userId: caller.userId }
				const bot = yield* fresh({
					...input,
					owner,
					now: yield* Clock.currentTimeMillis,
				})
				yield* writable(caller, bot)
				return yield* put(caller.organizationId, bot)
			}),
		createOwned: (organizationId, owner, input) =>
			Effect.gen(function* () {
				return yield* put(
					organizationId,
					yield* fresh({
						...input,
						owner: ownerFor(owner),
						now: yield* Clock.currentTimeMillis,
					}),
				)
			}),
		// The archive of the Bots below and the end of the membership commit together
		// with the Bot. A stop in the middle then leaves no active Bot under an archived one.
		update: (caller, id, input) =>
			records.transaction(
				"bot:" + caller.organizationId + ":" + id,
				Effect.gen(function* () {
					const bot = yield* change(
						caller,
						id,
						"write",
						input.expected,
						(bot) => {
							// The people of the shared Bot change these fields, not its members.
							if (
								bot.source !== undefined &&
								(input.name !== undefined ||
									input.role !== undefined ||
									input.instructions !== undefined ||
									input.model !== undefined)
							)
								return Effect.fail(
									BotsApi.BotInvalid.make({
										message:
											"This Bot is shared with you. Only its own people can change its name, role, instructions and model.",
									}),
								)
							const { model: _model, planApproval: _approval, ...rest } = bot
							const model =
								input.model === undefined
									? bot.model
									: (input.model ?? undefined)
							// A `null` makes the Bot follow the settings of the member again.
							const planApproval =
								input.planApproval === undefined
									? bot.planApproval
									: (input.planApproval ?? undefined)
							return Effect.succeed({
								...rest,
								...(input.name === undefined ? {} : { name: input.name }),
								...(input.role === undefined ? {} : { role: input.role }),
								...(input.instructions === undefined
									? {}
									: { instructions: input.instructions }),
								...(input.archived === undefined
									? {}
									: { archived: input.archived }),
								...(model === undefined ? {} : { model }),
								...(planApproval === undefined ? {} : { planApproval }),
							})
						},
					)
					// The Bots that an archived Bot owns are archived with it.
					if (input.archived === true)
						yield* archiveTree(caller.organizationId, [bot], bot.updatedAt)
					// Archiving a linked Bot ends the membership of its owner.
					if (input.archived === true && bot.source !== undefined)
						yield* memberships.remove(
							bot.source.organizationId,
							membershipId(bot.source.bot, caller.userId),
						)
					return bot
				}),
			),
		link: (caller, source) =>
			records.transaction(
				"bot_member:" +
					source.organizationId +
					":" +
					membershipId(source.bot.id, caller.userId),
				Effect.gen(function* () {
					const id = membershipId(source.bot.id, caller.userId)
					const existing = yield* memberships.find(source.organizationId, id)
					if (Option.isSome(existing)) {
						const linked = yield* find(
							existing.value.organizationId,
							existing.value.linked,
						)
						if (Option.isSome(linked) && !linked.value.archived)
							return linked.value
					}
					const now = yield* Clock.currentTimeMillis
					const bot: Bot = {
						...(yield* fresh({
							owner: { _tag: "Member", userId: caller.userId },
							name: source.bot.name,
							role: source.bot.role,
							instructions: source.bot.instructions,
							now,
						})),
						source: {
							organizationId: source.organizationId,
							bot: source.bot.id,
						},
					}
					yield* writable(caller, bot)
					yield* put(caller.organizationId, bot)
					yield* memberships.put(
						{
							organizationId: source.organizationId,
							id,
							owner: source.bot.id,
							scope: caller.userId,
							status: "",
						},
						{
							bot: source.bot.id,
							userId: caller.userId,
							organizationId: caller.organizationId,
							linked: bot.id,
							joinedAt: now,
						},
					)
					return yield* find(caller.organizationId, bot.id).pipe(
						Effect.map(Option.getOrElse(() => bot)),
					)
				}),
			),
		members: (organizationId, bot) =>
			memberships
				.list(organizationId, { owner: bot })
				.pipe(
					Effect.map((list) =>
						Arr.map(list, ({ bot: _bot, ...member }) => member),
					),
				),
		removeMember: (organizationId, bot, userId) =>
			Effect.gen(function* () {
				const id = membershipId(bot, userId)
				const found = yield* memberships.find(organizationId, id)
				if (Option.isNone(found)) return false
				yield* memberships.remove(organizationId, id)
				return true
			}),
		ownerChain: (subject, bot) => climb(subject, bot, [bot.id], [bot.id]),
	})
})
export const layer = Layer.effect(Bots, make)

export type { BotId }
