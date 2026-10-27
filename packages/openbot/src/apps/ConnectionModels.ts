import { AppConnections, ConnectionId } from "@openbot-build/domain"
import { Discovery, Document } from "@openbot-build/protocol"
import { Schema } from "effect"

/** The stored draft joins product state with an App protocol result. */
export const Draft = Schema.Struct({
	...AppConnections.DraftState.fields,
	discovery: Discovery.Result,
})
export type Draft = typeof Draft.Type

/** The public connection joins product state and the published protocol card. */
export interface Connection {
	readonly id: ConnectionId
	readonly name: string
	readonly cardUrl: string
	readonly card: Document.ServerCard
	readonly endpoint: string
	readonly remoteIndex: number
	readonly sources: ReadonlyArray<Discovery.Source>
	readonly configuration: Readonly<Record<string, string>>
	readonly enabled: boolean
	readonly revision: number
	readonly availability: typeof AppConnections.Availability.Type
}
export interface Create {
	readonly draftId: string
	readonly revision: number
	readonly cardUrl: string
	readonly remoteIndex: number
	readonly name: string
	readonly values: Readonly<Record<string, string>>
	readonly confirmed: true
}
