import type { Plugin, Session } from "@openbot-build/core"
import { MemoryOverrides } from "@openbot-build/platform-api"
import type { Memory } from "@openbot-build/plugin-memory"
import { Schema } from "effect"

/** The Platform plugin that adds the host toolkit, the user plugin and the execution services. */
export const sessionHostId = Schema.Literal(
	"@openbot-build/platform/session-host",
)
	.pipe(Schema.brand("@openbot-build/core/PluginId"))
	.make("@openbot-build/platform/session-host")

/** Platform data for one Session. It does not follow the Timeline. */
export const SessionHostState = Schema.Struct({
	memory: Schema.optionalKey(MemoryOverrides),
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

/** The Platform data of a Session. The store checks it with sessionHostStore when it loads. */
export const hostState = (session: Session.Ref): SessionHostState =>
	(session.business[sessionHostId] as SessionHostState | undefined) ?? {}

export const overrides = (session: Session.Ref): MemoryOverrides =>
	hostState(session).memory ?? {}

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
