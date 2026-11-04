import { Client } from "@openbot-build/protocol"
import { Array as Arr, Effect, HashSet } from "effect"

export interface Catalog {
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

export type Declaration =
	| Pick<Client.ResolvedTool, "kind" | "definition">
	| Pick<Client.ResolvedResource, "kind" | "definition">
	| Pick<Client.ResolvedTemplate, "kind" | "definition">
	| Pick<Client.ResolvedPrompt, "kind" | "definition">

/**
 * The most capability pages that `pages` reads.
 * The SDK list helpers stop at 64 pages, but `singlePage` goes around them, so `pages` keeps the same limit.
 */
const maxPages = 64

export const pages = <A>(
	read: (cursor?: string) => Effect.Effect<
		{
			readonly values: ReadonlyArray<A>
			readonly nextCursor?: string | undefined
		},
		Client.Error
	>,
) => {
	const from = (
		cursor: string | undefined,
		seen: HashSet.HashSet<string>,
		count: number,
	): Effect.Effect<ReadonlyArray<A>, Client.Error> =>
		read(cursor).pipe(
			Effect.flatMap((page) => {
				const next = page.nextCursor
				if (next === undefined) return Effect.succeed(page.values)
				if (HashSet.has(seen, next))
					return Effect.fail(
						Client.ClientError.make({
							reason: "Protocol",
							issue: "The App repeated a capability cursor.",
						}),
					)
				if (count >= maxPages)
					return Effect.fail(
						Client.ClientError.make({
							reason: "Protocol",
							issue: "The App sent too many capability pages.",
						}),
					)
				return from(next, HashSet.add(seen, next), count + 1).pipe(
					Effect.map((rest) => Arr.appendAll(page.values, rest)),
				)
			}),
		)
	return from(undefined, HashSet.empty(), 1)
}
/**
 * How OpenBot reads each capability list of an App: one page at a time, as
 * the host. Resource templates have no flag of their own, so they use the
 * `resources` flag.
 */
export const capabilityLists = (client: Client.Client) => {
	const advertised = client.discovery.capabilities
	return {
		tools: {
			advertised: advertised.tools !== undefined,
			page: (cursor?: string) =>
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
		},
		resources: {
			advertised: advertised.resources !== undefined,
			page: (cursor?: string) =>
				client.listResources(cursor, "host", { singlePage: true }).pipe(
					Effect.map((page) => ({
						values: page.resources,
						nextCursor: page.nextCursor,
					})),
				),
		},
		resourceTemplates: {
			advertised: advertised.resources !== undefined,
			page: (cursor?: string) =>
				client.listResourceTemplates(cursor, "host", { singlePage: true }).pipe(
					Effect.map((page) => ({
						values: page.resourceTemplates,
						nextCursor: page.nextCursor,
					})),
				),
		},
		prompts: {
			advertised: advertised.prompts !== undefined,
			page: (cursor?: string) =>
				client.listPrompts(cursor, "host", { singlePage: true }).pipe(
					Effect.map((page) => ({
						values: page.prompts,
						nextCursor: page.nextCursor,
					})),
				),
		},
	}
}

/** Read tools for callers that need the whole tool list. */
export const tools = (
	client: Client.Client,
): Effect.Effect<Catalog["tools"], Client.Error> => {
	const list = capabilityLists(client).tools
	return list.advertised ? pages(list.page) : Effect.succeed([])
}

/** Read the full catalog only when the caller needs all declarations. */
export const discover = (
	client: Client.Client,
): Effect.Effect<Catalog, Client.Error> =>
	Effect.gen(function* () {
		const lists = capabilityLists(client)
		return {
			tools: lists.tools.advertised ? yield* pages(lists.tools.page) : [],
			resources: lists.resources.advertised
				? yield* pages(lists.resources.page)
				: [],
			resourceTemplates: lists.resourceTemplates.advertised
				? yield* pages(lists.resourceTemplates.page)
				: [],
			prompts: lists.prompts.advertised ? yield* pages(lists.prompts.page) : [],
		}
	})

export const declarations = (catalog: Catalog): ReadonlyArray<Declaration> => [
	...Arr.map(catalog.tools, (definition) => ({
		kind: "tool" as const,
		definition,
	})),
	...Arr.map(catalog.resources, (definition) => ({
		kind: "resource" as const,
		definition,
	})),
	...Arr.map(catalog.resourceTemplates, (definition) => ({
		kind: "template" as const,
		definition,
	})),
	...Arr.map(catalog.prompts, (definition) => ({
		kind: "prompt" as const,
		definition,
	})),
]
