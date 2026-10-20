import { Chunk } from "effect"
import {
	Array as EffectArray,
	Option,
	HashSet,
	HashMap,
	Clock,
	Effect,
	Equal,
	Layer,
	Ref,
	Schema,
	Match,
	Predicate,
} from "effect"
import { parse, defaultTreeAdapter, type DefaultTreeAdapterTypes } from "parse5"
import * as Document from "../Document.ts"
import * as Network from "../network/Network.ts"
import {
	Source,
	Candidate,
	Issue,
	DiscoveryError,
	Discovery,
	Rules,
	type ConfigurationRequirement,
	type Update,
	type Error,
	type Options,
} from "./Discovery.ts"

export const compare = (options: {
	readonly previous: Candidate
	readonly current: Candidate
}): Update => {
	const hints = (candidate: Candidate) =>
		candidate.endpoints.map(({ remote }) => ({
			url: remote.url,
			type: remote.type,
			versions: remote.supportedProtocolVersions,
			variables: Object.fromEntries(
				Object.entries(remote.variables ?? {}).map(([name, input]) => [
					name,
					[input.value, input.default, input.isRequired, input.choices],
				]),
			),
			headers: (remote.headers ?? []).map((h) => [
				h.name,
				h.value,
				h.default,
				h.isRequired,
				h.choices,
				h.variables,
			]),
		}))
	return Equal.equals(hints(options.previous), hints(options.current))
		? { _tag: "DescriptionUpdated", candidate: options.current }
		: {
				_tag: "NeedsRevalidation",
				candidate: options.current,
				reason: "ConnectionDescriptionChanged",
			}
}

/** A domain means a well-known lookup. An explicit URL always keeps its path and query. */
export const inputLink = (
	input: string,
): Effect.Effect<string, Document.InvalidLink | Schema.SchemaError> => {
	const value = input.trim()
	if (/^https:\/\//i.test(value))
		return Schema.decodeEffect(Document.Link)(value)
	if (
		!/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::\d+)?$/i.test(
			value,
		)
	) {
		return Effect.fail(
			new Document.InvalidLink({
				reason: "Expected a domain or an absolute HTTPS Link",
			}),
		)
	}
	return Schema.decodeEffect(Document.Link)(
		`https://${value}/.well-known/ai-catalog.json`,
	)
}

/** Private values are returned only in the selected connection configuration. */
export const configureEndpoint = Effect.fn("Discovery.configureEndpoint")(
	function* (options: {
		readonly candidate: Candidate
		readonly index: number
		readonly values: Readonly<Record<string, string>>
	}) {
		const endpoint = options.candidate.endpoints.find(
			(e) => e.index === options.index,
		)
		if (endpoint === undefined)
			return yield* new DiscoveryError({
				reason: "Configuration",
				issues: [
					{
						url: options.candidate.cardUrl,
						reason: "Choose an available endpoint explicitly",
					},
				],
			})
		let issues: ReadonlyArray<Issue> = []
		const value = (key: string, input: Document.Input | undefined) => {
			const result = input?.value ?? options.values[key] ?? input?.default
			if (
				result !== undefined &&
				((input?.choices !== undefined && !input.choices.includes(result)) ||
					(input?.format === "boolean" &&
						!["true", "false"].includes(result)) ||
					(input?.format === "number" &&
						(!Number.isFinite(Number(result)) || result.trim() === "")))
			) {
				issues = EffectArray.append(issues, {
					url: options.candidate.cardUrl,
					reason: `Invalid configuration: ${key}`,
					fieldPath: key,
				})
			}
			return result
		}
		const substitute = (
			template: string,
			prefix: string,
			variables: typeof endpoint.remote.variables,
		) =>
			template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name: string) => {
				const result = value(`${prefix}${name}`, variables?.[name])
				if (result === undefined)
					issues = EffectArray.append(issues, {
						url: options.candidate.cardUrl,
						reason: `Missing configuration: ${prefix}${name}`,
						fieldPath: `${prefix}${name}`,
					})
				return result ?? ""
			})
		for (const req of endpoint.requirements) {
			if (options.values[req.key] === undefined)
				issues = EffectArray.append(issues, {
					url: options.candidate.cardUrl,
					reason: `Missing configuration: ${req.key}`,
					fieldPath: req.key,
				})
		}
		const url = substitute(
			endpoint.remote.url,
			"variable:",
			endpoint.remote.variables,
		)
		const headers: Record<string, string> = {}
		for (const header of endpoint.remote.headers ?? []) {
			const configured = value(`header:${header.name}`, header)
			if (configured === undefined) continue
			const rendered = substitute(
				configured,
				`header:${header.name}:variable:`,
				header.variables,
			)
			if (
				/^(?:authorization|cookie|host|origin|mcp-.*)$/i.test(header.name) ||
				/[\r\n]/.test(rendered)
			) {
				issues = EffectArray.append(issues, {
					url: options.candidate.cardUrl,
					reason: `Reserved or invalid connection header: ${header.name}`,
					fieldPath: `header:${header.name}`,
				})
			} else headers[header.name] = rendered
		}
		if (issues.length > 0)
			return yield* new DiscoveryError({
				reason: "Configuration",
				issues,
			})
		return {
			url: yield* Schema.decodeEffect(Document.Link)(url),
			headers,
			remoteIndex: options.index,
		}
	},
)

/** RFC Link relations, including multiple values and quoted commas. */
export const catalogLinks = (options: {
	readonly responseUrl: string
	readonly link?: string | undefined
	readonly html?: string | undefined
}): ReadonlyArray<string> => {
	let declarations: ReadonlyArray<string> = []
	const header = options.link ?? ""
	for (const match of header.matchAll(
		/<([^<>]+)>\s*((?:;\s*[\w-]+=(?:"[^"]*"|[^,;\s]+))*)/g,
	)) {
		const rel = /;\s*rel=(?:"([^"]*)"|([^,;\s]+))/i.exec(match[2] ?? "")
		if (
			(rel?.[1] ?? rel?.[2] ?? "")
				.toLowerCase()
				.split(/\s+/)
				.includes("ai-catalog") &&
			match[1] !== undefined
		)
			declarations = EffectArray.append(declarations, match[1])
	}
	let base = options.responseUrl
	if (declarations.length === 0 && options.html !== undefined) {
		const document = parse(options.html)
		const html = document.childNodes.find(
			(node): node is DefaultTreeAdapterTypes.Element =>
				defaultTreeAdapter.isElementNode(node) && node.tagName === "html",
		)
		const head = html?.childNodes.find(
			(node): node is DefaultTreeAdapterTypes.Element =>
				defaultTreeAdapter.isElementNode(node) && node.tagName === "head",
		)
		const elements = (head?.childNodes ?? []).filter(
			defaultTreeAdapter.isElementNode,
		)
		const baseTag = elements.find(
			(node) =>
				node.tagName === "base" && node.attrs.some((a) => a.name === "href"),
		)
		const baseHref = baseTag?.attrs.find((a) => a.name === "href")?.value
		if (baseHref !== undefined) {
			try {
				base = new URL(baseHref, options.responseUrl).href
			} catch {
				/* HTML URL resolution ignores an invalid base. */
			}
		}
		for (const node of elements) {
			const rel = node.attrs
				.find((a) => a.name === "rel")
				?.value.toLowerCase()
				.split(/\s+/)
			const href = node.attrs.find((a) => a.name === "href")?.value
			if (
				node.tagName === "link" &&
				rel?.includes("ai-catalog") === true &&
				href !== undefined
			)
				declarations = EffectArray.append(declarations, href)
		}
	}
	return EffectArray.dedupe(
		declarations.flatMap((href) => {
			try {
				return [new URL(href, base).href]
			} catch {
				return []
			}
		}),
	)
}

type Parsed =
	| { readonly _tag: "Card"; readonly card: Document.ServerCard }
	| { readonly _tag: "Catalog"; readonly catalog: Document.Catalog }
	| { readonly _tag: "Page"; readonly links: ReadonlyArray<string> }

interface Cached {
	readonly response: Network.DocumentResponse
	readonly parsed: Parsed
	readonly freshUntil: number
}

export const layer = (options: Options = {}) =>
	Layer.effect(
		Discovery,
		Effect.gen(function* () {
			const rules = yield* Rules
			const network = yield* Network.Network
			const cache = yield* Ref.make<HashMap.HashMap<string, Cached>>(
				HashMap.empty(),
			)
			const fetchDocument = Effect.fn("Discovery.fetchDocument")(function* (
				input: string,
				refresh: boolean = false,
			) {
				const url = yield* Schema.decodeEffect(Document.Link)(input)
				const accept = `${Document.cardMediaType}, ${Document.catalogMediaType}, text/html`
				const key = JSON.stringify([
					network.identity.scope,
					network.identity.owner,
					url,
					accept,
				])
				const cached = Option.getOrUndefined(
					HashMap.get(yield* Ref.get(cache), key),
				)
				const now = yield* Clock.currentTimeMillis
				if (!refresh && cached !== undefined && cached.freshUntil > now)
					return {
						response: cached.response,
						parsed: cached.parsed,
					}
				const headers: Record<string, string> = {
					...options.headersByOrigin?.[new URL(url).origin],
					accept,
				}
				if (cached?.response.headers["etag"] !== undefined)
					headers["if-none-match"] = cached.response.headers["etag"]
				if (cached?.response.headers["last-modified"] !== undefined)
					headers["if-modified-since"] =
						cached.response.headers["last-modified"]
				const received = yield* network.readDocument({
					url,
					headers,
				})
				if (received.status === 304 && cached === undefined)
					return yield* new DiscoveryError({
						reason: "Http",
						issues: [
							{
								url,
								reason: "304 without a validated cached copy",
							},
						],
					})
				const response =
					received.status === 304 && cached !== undefined
						? {
								...cached.response,
								headers: {
									...cached.response.headers,
									...received.headers,
								},
							}
						: received
				if (response.status !== 200)
					return yield* new DiscoveryError({
						reason: "Http",
						issues: [
							{
								url,
								reason: `HTTP ${response.status}`,
							},
						],
					})
				const media = response.headers["content-type"]
					?.split(";")[0]
					?.trim()
					.toLowerCase()
				let parsed: Parsed
				const pageLinks = rules.catalogLinks({
					responseUrl: response.url,
					link: response.headers["link"],
					html: media === "text/html" ? response.text : undefined,
				})
				if (
					media === "text/html" ||
					(pageLinks.length > 0 &&
						![
							Document.cardMediaType,
							Document.catalogMediaType,
							"application/json",
						].includes(media ?? ""))
				) {
					const links = pageLinks
					if (links.length === 0)
						return yield* new DiscoveryError({
							reason: "NoDeclaration",
							issues: [
								{
									url,
									reason: "No static ai-catalog declaration",
								},
							],
						})
					parsed = { _tag: "Page", links }
				} else {
					const value = yield* Schema.decodeEffect(
						Schema.fromJsonString(Schema.Unknown),
					)(response.text).pipe(
						Effect.mapError(
							(e) =>
								new DiscoveryError({
									reason: "Document",
									issues: [
										{
											url,
											reason: e.message,
										},
									],
								}),
						),
					)
					if (
						media === Document.cardMediaType ||
						Predicate.hasProperty(value, "$schema")
					)
						parsed = {
							_tag: "Card",
							card: yield* Document.ServerCard.decode(value),
						}
					else
						parsed = {
							_tag: "Catalog",
							catalog: yield* Document.Catalog.decode(value),
						}
				}
				const control = response.headers["cache-control"]?.toLowerCase() ?? ""
				const maxAge = /(?:^|,)\s*max-age=(\d+)/.exec(control)?.[1]
				const freshUntil =
					control.includes("no-cache") || maxAge === undefined
						? now
						: now +
							Math.max(
								0,
								Number(maxAge) - Number(response.headers["age"] ?? "0"),
							) *
								1000
				yield* Ref.update(cache, (old) => {
					let updated = old
					if (control.includes("no-store"))
						updated = HashMap.remove(updated, key)
					else
						updated = HashMap.set(updated, key, {
							response,
							parsed,
							freshUntil,
						})
					return updated
				})
				return { response, parsed }
			})
			const makeCandidate = Effect.fn("Discovery.makeCandidate")(
				function* (options: {
					readonly cardUrl: string
					readonly response: Network.DocumentResponse
					readonly card: Document.ServerCard
					readonly sources: ReadonlyArray<Source>
				}) {
					const remotes = yield* Document.compatibleRemotes(options.card)
					return {
						cardUrl: options.cardUrl,
						card: options.card,
						endpoints: remotes.map((remote) => ({
							index: (options.card.remotes ?? []).indexOf(remote),
							remote,
							requirements: rules.requirements(remote),
						})),
						sources: [
							...options.sources,
							{
								role: "card" as const,
								url: options.cardUrl,
							},
							...(options.response.url === options.cardUrl
								? []
								: [
										{
											role: "card" as const,
											url: options.response.url,
										},
									]),
							...remotes.map((remote) => ({
								role: "endpoint" as const,
								url: remote.url,
							})),
						],
					} satisfies Candidate
				},
			)
			const fetchCard = Effect.fn("Discovery.fetchCard")(function* (
				input: string,
				sources: ReadonlyArray<Source>,
				refresh: boolean = false,
			) {
				const cardUrl = yield* Schema.decodeEffect(Document.Link)(input)
				const { response, parsed } = yield* fetchDocument(cardUrl, refresh)
				const card = yield* Match.value(parsed).pipe(
					Match.tag("Card", ({ card }) => Effect.succeed(card)),
					Match.orElse(() =>
						Effect.fail(
							new DiscoveryError({
								reason: "Document",
								issues: [{ url: input, reason: "Expected Server Card" }],
							}),
						),
					),
				)
				return yield* makeCandidate({
					cardUrl,
					response,
					card,
					sources,
				})
			})
			const resolveInput = Effect.fn("Discovery.resolve")(function* (
				input: string,
			) {
				const url = yield* rules.inputLink(input)
				let candidates = HashMap.empty<string, Candidate>()
				let candidateOrder = Chunk.empty<string>()
				let issues: ReadonlyArray<Issue> = []
				let visited = HashSet.empty<string>()
				const visit = (
					url: string,
					sources: ReadonlyArray<Source>,
				): Effect.Effect<void, Error> =>
					Effect.gen(function* () {
						const identity = yield* Schema.decodeEffect(Document.Link)(url)
						if (HashSet.has(visited, identity)) return
						visited = HashSet.add(visited, identity)
						const { response, parsed } = yield* fetchDocument(identity)
						return yield* Match.value(parsed).pipe(
							Match.tag("Card", ({ card }) =>
								Effect.gen(function* () {
									const candidate = yield* makeCandidate({
										cardUrl: identity,
										response,
										card,
										sources,
									})
									if (!HashMap.has(candidates, candidate.cardUrl))
										candidateOrder = Chunk.append(
											candidateOrder,
											candidate.cardUrl,
										)
									candidates = HashMap.set(
										candidates,
										candidate.cardUrl,
										candidate,
									)
								}),
							),
							Match.orElse((parsed) =>
								Effect.gen(function* () {
									const { role, urls } = Match.value(parsed).pipe(
										Match.tagsExhaustive({
											Page: (parsed) => ({
												role: "page" as const,
												urls: parsed.links,
											}),
											Catalog: (parsed) => ({
												role: "catalog" as const,
												urls: parsed.catalog.entries.flatMap((entry) =>
													Match.value(entry.type).pipe(
														Match.whenOr(
															Document.cardMediaType,
															Document.catalogMediaType,
															() => {
																if (entry.url !== undefined) return [entry.url]
																issues = EffectArray.append(issues, {
																	url: response.url,
																	reason: `Inline-only entry ${entry.identifier} has no stable Card URL`,
																})
																return []
															},
														),
														Match.orElse(() => []),
													),
												),
											}),
										}),
									)
									const chain = [
										...sources,
										{
											role,
											url: identity,
										},
										...(response.url === identity
											? []
											: [
													{
														role,
														url: response.url,
													},
												]),
									]
									for (const target of urls) {
										const result = yield* Effect.result(visit(target, chain))
										Match.value(result).pipe(
											Match.tag("Failure", ({ failure }) => {
												issues = EffectArray.append(issues, {
													url: target,
													reason: String(failure),
												})
											}),
											Match.orElse(() => undefined),
										)
									}
								}),
							),
						)
					})
				yield* visit(url, [
					{
						role: "input",
						url,
						originalInput: input,
					},
				])
				const values = Array.from(candidateOrder, (url) =>
					HashMap.getUnsafe(candidates, url),
				)
				const first = values[0]
				const second = values[1]
				if (first === undefined)
					return yield* new DiscoveryError({
						reason: "NoUsableServices",
						issues,
					})
				return second === undefined
					? {
							_tag: "Single" as const,
							candidate: first,
							issues,
						}
					: {
							_tag: "Multiple" as const,
							candidates: [first, second, ...values.slice(2)] as const,
							issues,
						}
			})
			return Discovery.of({
				resolve: resolveInput,
				refreshCard: (url) => fetchCard(url, [{ role: "input", url }], true),
				refresh: (previous) =>
					fetchCard(
						previous.cardUrl,
						[
							{
								role: "input",
								url: previous.cardUrl,
							},
						],
						true,
					).pipe(
						Effect.map((current) =>
							rules.compare({
								previous,
								current,
							}),
						),
					),
			})
		}),
	)

const referencedVariables = (s: string) =>
	[...s.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)]
		.map((m) => m[1])
		.filter((v): v is string => v !== undefined)

const requirement = (
	key: string,
	input: Document.Input,
): ConfigurationRequirement => ({
	key,
	description: input.description,
	isSecret: input.isSecret === true,
	format: input.format,
	choices: input.choices,
})

export const requirements = (
	remote: Document.Remote,
): ReadonlyArray<ConfigurationRequirement> => {
	let result: ReadonlyArray<ConfigurationRequirement> = []
	for (const [name, input] of Object.entries(remote.variables ?? {})) {
		if (
			(input.isRequired === true ||
				referencedVariables(remote.url).includes(name)) &&
			input.value === undefined &&
			input.default === undefined
		)
			result = EffectArray.append(
				result,
				requirement(`variable:${name}`, input),
			)
	}
	for (const name of referencedVariables(remote.url)) {
		if (remote.variables?.[name] === undefined)
			result = EffectArray.append(result, {
				key: `variable:${name}`,
				isSecret: false,
			})
	}
	for (const header of remote.headers ?? []) {
		if (
			header.isRequired === true &&
			header.value === undefined &&
			header.default === undefined
		)
			result = EffectArray.append(
				result,
				requirement(`header:${header.name}`, header),
			)
		for (const [name, input] of Object.entries(header.variables ?? {})) {
			if (
				(input.isRequired === true ||
					referencedVariables(header.value ?? "").includes(name)) &&
				input.value === undefined &&
				input.default === undefined
			)
				result = EffectArray.append(
					result,
					requirement(`header:${header.name}:variable:${name}`, input),
				)
		}
		for (const name of referencedVariables(header.value ?? "")) {
			if (header.variables?.[name] === undefined)
				result = EffectArray.append(result, {
					key: `header:${header.name}:variable:${name}`,
					isSecret: header.isSecret === true,
				})
		}
	}
	return result
}

export const layerRules = Layer.succeed(Rules, {
	compare,
	inputLink,
	configureEndpoint,
	catalogLinks,
	requirements,
})
