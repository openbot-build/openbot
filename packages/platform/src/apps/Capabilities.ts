import { ConnectionsApi as Api } from "@openbot-build/platform-api"
import { App, Client, Discovery, Document, Ui } from "@openbot-build/protocol"
import {
	Array as Arr,
	Context,
	Data,
	Effect,
	HashSet,
	Layer,
	Schema,
	type Scope,
} from "effect"
import { AppHost } from "./AppHost.ts"
import { Governance } from "./Governance.ts"
import {
	Repository,
	type Error as RepositoryError,
	type StoredConnection,
} from "./Repository.ts"

export class Unavailable extends Data.TaggedError(
	"AppCapabilitiesUnavailable",
)<{ readonly reason: "Disabled" | "NeedsRevalidation" }> {}
export type Error =
	| Client.Error
	| RepositoryError
	| Api.AppRestricted
	| Discovery.Error
	| Unavailable
export interface Opened {
	readonly stored: StoredConnection
	readonly client: Client.Client
	readonly tools: Readonly<
		Effect.Success<ReturnType<Client.Client["listTools"]>>["tools"]
	>
	readonly resources: Readonly<
		Effect.Success<ReturnType<Client.Client["listResources"]>>["resources"]
	>
	readonly resourceTemplates: Readonly<
		Effect.Success<
			ReturnType<Client.Client["listResourceTemplates"]>
		>["resourceTemplates"]
	>
	readonly prompts: Readonly<
		Effect.Success<ReturnType<Client.Client["listPrompts"]>>["prompts"]
	>
}

export class Capabilities extends Context.Service<
	Capabilities,
	{
		readonly open: (input: {
			readonly owner: string
			readonly connectionId: string
			readonly policy: typeof Client.InvocationPolicy.Service
		}) => Effect.Effect<Opened, Error, Scope.Scope>
	}
>()("@openbot-build/platform/apps/Capabilities") {}

export const pages = <A>(
	read: (cursor?: string) => Effect.Effect<
		{
			readonly values: ReadonlyArray<A>
			readonly nextCursor?: string | undefined
		},
		Client.Error
	>,
) =>
	Effect.gen(function* () {
		let all: ReadonlyArray<A> = []
		let cursor: string | undefined
		let seen = HashSet.empty<string>()
		do {
			const page = yield* read(cursor)
			all = Arr.appendAll(all, page.values)
			cursor = page.nextCursor
			if (cursor !== undefined) {
				if (HashSet.has(seen, cursor))
					return yield* new Client.ClientError({
						reason: "Protocol",
						issue: "The App repeated a capability cursor.",
					})
				seen = HashSet.add(seen, cursor)
			}
		} while (cursor !== undefined)
		return all
	})
export const make: Effect.Effect<
	typeof Capabilities.Service,
	never,
	AppHost | Repository | Governance | Discovery.Discovery | App.ConnectionScopes
> = Effect.gen(function* () {
	const factory = yield* AppHost
	const repository = yield* Repository
	const governance = yield* Governance
	const discovery = yield* Discovery.Discovery
	const scopes = yield* App.ConnectionScopes
	const sameRemote = Schema.toEquivalence(Schema.UndefinedOr(Document.Remote))
	return Capabilities.of({
		open: Effect.fn("Apps.openCapabilities")(function* (input) {
			const stored = yield* repository.get(input.owner, input.connectionId)
			yield* governance.check(stored.connection.cardUrl)
			if (stored.connection.state !== "Enabled")
				return yield* new Unavailable({
					reason:
						stored.connection.state === "NeedsRevalidation"
							? "NeedsRevalidation"
							: "Disabled",
				})
			const previous = yield* repository.getApp(
				input.owner,
				stored.connection.cardUrl,
			)
			if (!previous.sources.some((source) => source.role === "manual")) {
				const declared = yield* discovery.refreshCard(stored.connection.cardUrl)
				if (
					!sameRemote(
						previous.card.remotes?.[stored.connection.remoteIndex],
						declared.card.remotes?.[stored.connection.remoteIndex],
					)
				) {
					yield* repository.update(
						input.owner,
						input.connectionId,
						(row) => ({
							...row,
							connection: { ...row.connection, state: "NeedsRevalidation" },
							verification: { _tag: "NeedsRevalidation" },
						}),
						stored.revision,
					)
					yield* scopes.close(input)
					yield* repository.updateApp(input.owner, {
						cardUrl: declared.cardUrl,
						card: declared.card,
						sources: declared.sources,
					})
					return yield* new Unavailable({ reason: "NeedsRevalidation" })
				}
				yield* repository.updateApp(input.owner, {
					cardUrl: declared.cardUrl,
					card: declared.card,
					sources: declared.sources,
				})
			}
			const client = yield* factory.bind(input.owner, input.policy).open({
				key: input,
				clientInfo: { name: "OpenBot", version: "1.0.0" },
				capabilities: { ...Ui.clientCapabilities, elicitation: { form: {} } },
			})
			const advertised = client.discovery.capabilities
			return {
				stored,
				client,
				tools:
					advertised.tools === undefined
						? []
						: yield* pages((cursor) =>
								client
									.listTools({
										...(cursor === undefined ? {} : { cursor }),
										source: "host",
										singlePage: true,
									})
									.pipe(
										Effect.map((page) => ({
											values: page.tools,
											nextCursor: page.nextCursor,
										})),
									),
							),
				resources:
					advertised.resources === undefined
						? []
						: yield* pages((cursor) =>
								client.listResources(cursor, "host", { singlePage: true }).pipe(
									Effect.map((page) => ({
										values: page.resources,
										nextCursor: page.nextCursor,
									})),
								),
							),
				resourceTemplates:
					advertised.resources === undefined
						? []
						: yield* pages((cursor) =>
								client
									.listResourceTemplates(cursor, "host", { singlePage: true })
									.pipe(
										Effect.map((page) => ({
											values: page.resourceTemplates,
											nextCursor: page.nextCursor,
										})),
									),
							),
				prompts:
					advertised.prompts === undefined
						? []
						: yield* pages((cursor) =>
								client.listPrompts(cursor, "host", { singlePage: true }).pipe(
									Effect.map((page) => ({
										values: page.prompts,
										nextCursor: page.nextCursor,
									})),
								),
							),
			}
		}),
	})
})
export const layer = Layer.effect(Capabilities, make)
