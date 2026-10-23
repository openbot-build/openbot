import { type Plugin, Session, type Turn } from "@openbot-build/core"
import {
	BotsApi,
	MemoryOverrides,
	PlanApproval,
	SessionKind,
	SessionParent,
} from "@openbot-build/api"
import type * as Memory from "../plugins/memory/Memory.ts"
import type * as Todos from "../plugins/work/Todos.ts"
import { Schema } from "effect"

/** The OpenBot plugin that adds the host toolkit, the user plugin and the execution services. */
const sessionHostKey = "@openbot-build/openbot/session-host"
export const sessionHostId = Schema.Literal(sessionHostKey)
	.pipe(Schema.brand("@openbot-build/core/PluginId"))
	.make(sessionHostKey)

/**
 * Who the work in a Session is for, and through which Bots it came.
 * `bots` starts with the Bot that the person or client called, and ends with the Bot of this Session.
 * `sessions` lists the Sessions before this one, in the same order.
 */
export const Chain = Schema.Struct({
	organizationId: Schema.String,
	userId: Schema.String,
	/** The token that started the work, when a token did. The work never does more than it may. */
	tokenId: Schema.optionalKey(Schema.String),
	/**
	 * The member whose Sessions hold the work, when it is not `userId`. In a chat Channel,
	 * the Sessions belong to the actor of the Channel, and each Turn works for its speaker.
	 */
	owner: Schema.optionalKey(Schema.String),
	bots: Schema.Array(BotsApi.BotId),
	sessions: Schema.Array(Session.Id),
})
export type Chain = typeof Chain.Type

/** OpenBot data for one Session. It does not follow the Timeline. */
export const SessionHostState = Schema.Struct({
	memory: Schema.optionalKey(MemoryOverrides),
	bot: BotsApi.BotId,
	kind: SessionKind,
	parent: Schema.optionalKey(SessionParent),
	chain: Chain,
	/** The request that a review Session decides. */
	review: Schema.optionalKey(Schema.String),
	/** The trigger that started a trigger Session. */
	trigger: Schema.optionalKey(Schema.String),
	/**
	 * The chat of a Channel that a channel Session belongs to. `group` is true for a chat
	 * with many people. Sessions from before it was kept count as groups, because that is safer.
	 */
	channel: Schema.optionalKey(
		Schema.Struct({
			channel: Schema.String,
			conversation: Schema.String,
			group: Schema.optionalKey(Schema.Boolean),
		}),
	),
	/** How plans in this Session are approved, when the Session sets it. */
	planApproval: Schema.optionalKey(PlanApproval.PlanApproval),
})
export type SessionHostState = typeof SessionHostState.Type
/** The plugin data in a Session: learned memory and the OpenBot data. */
export type Values = Memory.Values &
	Todos.Values & {
		readonly [sessionHostKey]?: SessionHostState
	}
export const sessionHostStore = {
	scope: "session",
	schema: Schema.toCodecJson(SessionHostState),
} satisfies Plugin.StoreDefinition<
	ReturnType<typeof Schema.toCodecJson<typeof SessionHostState>>
>

/**
 * The OpenBot data of a Session. The store checks it with sessionHostStore when it loads.
 * OpenBot writes it when it creates the Session, so every Session has it.
 */
export const hostState = (session: Session.Ref): SessionHostState =>
	session.business[sessionHostId] as SessionHostState

/**
 * Who one Turn works for. A Turn with an author, such as a speaker in a chat Channel,
 * works for that member and not for the owner of the Session. It never uses the token
 * of the owner.
 */
export const turnChain = (
	session: Session.Ref,
	turn: Turn.Id | undefined,
): Chain => {
	const chain = hostState(session).chain
	const author =
		turn === undefined
			? undefined
			: session.turns.find((record) => record.id === turn)?.author
	return author === undefined || author === chain.userId
		? chain
		: {
				organizationId: chain.organizationId,
				userId: author,
				owner: ownerOf(chain),
				bots: chain.bots,
				sessions: chain.sessions,
			}
}

/** The member whose Sessions hold the work of a chain. */
export const ownerOf = (chain: Chain) => chain.owner ?? chain.userId

export const overrides = (session: Session.Ref): MemoryOverrides =>
	hostState(session)?.memory ?? {}

/** The Bot fields of the API views of a Session. */
export const botFields = (session: Session.Ref) => {
	const state = hostState(session)
	return {
		bot: state.bot,
		kind: state.kind,
		parent: state.parent ?? null,
	}
}

/** The switches in use: the overrides of the Session, then the server default. */
export const settings = (input: {
	readonly defaults: Memory.Settings
	readonly session: Session.Ref
}): Memory.Settings => ({ ...input.defaults, ...overrides(input.session) })

/** A boolean sets a switch, null removes it, and a missing value keeps it. */
const change = (
	value: boolean | null | undefined,
	previous: boolean | undefined,
): boolean | undefined =>
	value === undefined ? previous : (value ?? undefined)

export const configure = (input: {
	readonly current: MemoryOverrides
	readonly command: {
		readonly use?: boolean | null
		readonly generate?: boolean | null
	}
}): MemoryOverrides => {
	const use = change(input.command.use, input.current.use),
		generate = change(input.command.generate, input.current.generate)
	return {
		...(use === undefined ? {} : { use }),
		...(generate === undefined ? {} : { generate }),
	}
}
