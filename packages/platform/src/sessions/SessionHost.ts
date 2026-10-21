import { type Plugin, Session } from "@openbot-build/core"
import {
	AgentsApi,
	MemoryOverrides,
	SessionKind,
	SessionParent,
} from "@openbot-build/platform-api"
import type { Memory } from "@openbot-build/plugin-memory"
import { Schema } from "effect"

/** The Platform plugin that adds the host toolkit, the user plugin and the execution services. */
export const sessionHostId = Schema.Literal(
	"@openbot-build/platform/session-host",
)
	.pipe(Schema.brand("@openbot-build/core/PluginId"))
	.make("@openbot-build/platform/session-host")

/**
 * Who the work in a Session is for, and through which Agents it came.
 * `agents` starts with the Agent that the person or client called, and ends with the Agent of this Session.
 * `sessions` lists the Sessions before this one, in the same order.
 */
export const Chain = Schema.Struct({
	organizationId: Schema.String,
	userId: Schema.String,
	/** The token that started the work, when a token did. The work never does more than it may. */
	tokenId: Schema.optionalKey(Schema.String),
	agents: Schema.Array(AgentsApi.AgentId),
	sessions: Schema.Array(Session.Id),
})
export type Chain = typeof Chain.Type

/** Platform data for one Session. It does not follow the Timeline. */
export const SessionHostState = Schema.Struct({
	memory: Schema.optionalKey(MemoryOverrides),
	agent: AgentsApi.AgentId,
	kind: SessionKind,
	parent: Schema.optionalKey(SessionParent),
	chain: Chain,
	/** The request that a review Session decides. */
	review: Schema.optionalKey(Schema.String),
})
export type SessionHostState = typeof SessionHostState.Type
/** The plugin data in a Session: learned memory and the Platform data. */
export type Values = Memory.Values & {
	readonly "@openbot-build/platform/session-host"?: SessionHostState
}
export const sessionHostStore = {
	scope: "session",
	schema: Schema.toCodecJson(SessionHostState),
} satisfies Plugin.StoreDefinition<
	ReturnType<typeof Schema.toCodecJson<typeof SessionHostState>>
>

/**
 * The Platform data of a Session. The store checks it with sessionHostStore when it loads.
 * Platform writes it when it creates the Session, so every Session has it.
 */
export const hostState = (session: Session.Ref): SessionHostState =>
	session.business[sessionHostId] as SessionHostState

export const overrides = (session: Session.Ref): MemoryOverrides =>
	hostState(session)?.memory ?? {}

/** The Agent fields of the API views of a Session. */
export const agentFields = (session: Session.Ref) => {
	const state = hostState(session)
	return {
		agent: state.agent,
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
