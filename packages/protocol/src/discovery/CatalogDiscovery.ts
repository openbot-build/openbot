import {
	Array as Arr,
	Cache,
	Chunk,
	Option,
	HashSet,
	Clock,
	Duration,
	Effect,
	Equal,
	Exit,
	Layer,
	Schema,
	Match,
	Predicate,
	Record as Rec,
	String as Str,
	pipe,
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
	ConfigurationRequirement,
	type Update,
	type Error,
	type Options,
	type Result,
} from "./Discovery.ts"

/** The input fields that change how a connection sends a request. */
const connectionInput = (input: Document.Input | Document.HeaderInput) => ({
	value: input.value,
	default: input.default,
	isRequired: input.isRequired,
	choices: input.choices,
	format: input.format,
	isSecret: input.isSecret,
})
const connectionDescription = (remote: Document.Remote | undefined) =>
	remote === undefined
		? undefined
		: {
				url: remote.url,
				type: remote.type,
				versions: remote.supportedProtocolVersions,
				variables: Rec.map(remote.variables ?? {}, connectionInput),
				headers: Arr.map(remote.headers ?? [], (header) => ({
					name: header.name,
					...connectionInput(header),
					variables: Rec.map(header.variables ?? {}, connectionInput),
				})),
			}

/** Text and extension fields do not change a connection. */
export const sameConnection = (
	previous: Document.Remote | undefined,
	current: Document.Remote | undefined,
): boolean =>
	Equal.equals(connectionDescription(previous), connectionDescription(current))

export const compare = (options: {
	readonly previous: Candidate
	readonly current: Candidate
}): Update => {
	const previous = options.previous.endpoints
	const current = options.current.endpoints
	return previous.length === current.length &&
		Arr.every(previous, (endpoint, index) =>
			sameConnection(endpoint.remote, current[index]?.remote),
		)
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
	const value = Str.trim(input)
	if (/^https:\/\//i.test(value))
		return Schema.decodeEffect(Document.Link)(value)
	if (
		!/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::\d+)?$/i.test(
			value,
		)
	) {
		return Effect.fail(
			Document.InvalidLink.make({
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
		const selected = Arr.findFirst(
			options.candidate.endpoints,
			(e) => e.index === options.index,
		)
		if (Option.isNone(selected))
			return yield* DiscoveryError.make({
				reason: "Configuration",
				issues: [
					{
						url: options.candidate.cardUrl,
						reason: "Choose an available endpoint explicitly",
					},
				],
			})
		const endpoint = selected.value
		let issues: ReadonlyArray<Issue> = []
		const value = (
			key: string,
			input: Document.Input | Document.HeaderInput | undefined,
		) => {
			const result = input?.value ?? options.values[key] ?? input?.default
			if (
				result !== undefined &&
				((input?.choices !== undefined && !input.choices.includes(result)) ||
					(input?.format === "boolean" &&
						!["true", "false"].includes(result)) ||
					(input?.format === "number" &&
						(!Number.isFinite(Number(result)) || Str.trim(result) === "")))
			) {
				issues = Arr.append(
					issues,
					Issue.make({
						url: options.candidate.cardUrl,
						reason: `Invalid configuration: ${key}`,
						fieldPath: key,
					}),
				)
			}
			return result
		}
		const substitute = (
			template: string,
			prefix: string,
			variables: typeof endpoint.remote.variables,
		) =>
			pipe(
				Str.split(template, /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/),
				// A split with a capture group puts each variable name at an odd index.
				Arr.map((part, index) => {
					if (index % 2 === 0) return part
					const result = value(`${prefix}${part}`, variables?.[part])
					if (result === undefined)
						issues = Arr.append(
							issues,
							Issue.make({
								url: options.candidate.cardUrl,
								reason: `Missing configuration: ${prefix}${part}`,
								fieldPath: `${prefix}${part}`,
							}),
						)
					return result ?? ""
				}),
				Arr.join(""),
			)
		for (const req of endpoint.requirements) {
			if (options.values[req.key] === undefined)
				issues = Arr.append(
					issues,
					Issue.make({
						url: options.candidate.cardUrl,
						reason: `Missing configuration: ${req.key}`,
						fieldPath: req.key,
					}),
				)
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
				issues = Arr.append(
					issues,
					Issue.make({
						url: options.candidate.cardUrl,
						reason: `Reserved or invalid connection header: ${header.name}`,
						fieldPath: `header:${header.name}`,
					}),
				)
			} else headers[header.name] = rendered
		}
		if (issues.length > 0)
			return yield* DiscoveryError.make({
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
	const isCatalog = (rel: string) =>
		pipe(rel, Str.toLowerCase, Str.split(/\s+/), Arr.contains("ai-catalog"))
	const attribute = (node: DefaultTreeAdapterTypes.Element, name: string) =>
		pipe(
			Arr.findFirst(node.attrs, (a) => a.name === name),
			Option.map((a) => a.value),
		)
	let declarations: ReadonlyArray<string> = []
	const header = options.link ?? ""
	for (const match of pipe(
		header,
		Str.matchAll(/<([^<>]+)>\s*((?:;\s*[\w-]+=(?:"[^"]*"|[^,;\s]+))*)/g),
	)) {
		const rel = /;\s*rel=(?:"([^"]*)"|([^,;\s]+))/i.exec(match[2] ?? "")
		if (isCatalog(rel?.[1] ?? rel?.[2] ?? "") && match[1] !== undefined)
			declarations = Arr.append(declarations, match[1])
	}
	let base = options.responseUrl
	if (declarations.length === 0 && options.html !== undefined) {
		const document = parse(options.html)
		const elements = pipe(
			Arr.findFirst(
				document.childNodes,
				(node): node is DefaultTreeAdapterTypes.Element =>
					defaultTreeAdapter.isElementNode(node) && node.tagName === "html",
			),
			Option.flatMap((html) =>
				Arr.findFirst(
					html.childNodes,
					(node): node is DefaultTreeAdapterTypes.Element =>
						defaultTreeAdapter.isElementNode(node) && node.tagName === "head",
				),
			),
			Option.map((head) =>
				Arr.filter(head.childNodes, defaultTreeAdapter.isElementNode),
			),
			Option.getOrElse(Arr.empty<DefaultTreeAdapterTypes.Element>),
		)
		const baseHref = Arr.findFirst(elements, (node) =>
			node.tagName === "base" ? attribute(node, "href") : Option.none(),
		)
		// HTML URL resolution ignores an invalid base.
		if (
			Option.isSome(baseHref) &&
			URL.canParse(baseHref.value, options.responseUrl)
		)
			base = new URL(baseHref.value, options.responseUrl).href
		for (const node of elements) {
			const href = attribute(node, "href")
			if (
				node.tagName === "link" &&
				Option.exists(attribute(node, "rel"), isCatalog) &&
				Option.isSome(href)
			)
				declarations = Arr.append(declarations, href.value)
		}
	}
	return Arr.dedupe(
		Arr.flatMap(declarations, (href) =>
			URL.canParse(href, base) ? [new URL(href, base).href] : [],
		),
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
	/** How long the cache keeps this entry. */
	readonly keepMillis: number
}

/** The cache drops the least recently used document when it has more. */
const cacheCapacity = 256
/** A stale document with an ETag or Last-Modified stays this much longer, so a later read can revalidate it. */
const staleKeepMillis = 86_400_000
/** One resolve reads at most this many documents. */
const maxDocuments = 64
/** Discovery follows at most this many links from one Catalog or page. */
const maxLinks = 64
/** One resolve must end in this time. */
const resolveDeadline = "60 seconds"

const failureIssues = (url: string, failure: Error): ReadonlyArray<Issue> =>
	Match.valueTags(failure, {
		DiscoveryError: (error) => error.issues,
		InvalidDocument: (error) => [
			Issue.make({ url, reason: `${error.kind}: ${error.issue}` }),
		],
		IncompatibleCard: (error) => [Issue.make({ url, reason: error.reason })],
		InvalidLink: (error) => [Issue.make({ url, reason: error.reason })],
		NetworkError: (error) => [
			Issue.make({ url, reason: `${error.reason}: ${error.message}` }),
		],
		SchemaError: (error) => [Issue.make({ url, reason: error.message })],
	})

export const layer = (options: Options = {}) =>
	Layer.effect(
		Discovery,
		Effect.gen(function* () {
			const rules = yield* Rules
			const network = yield* Network.Network
			// The cache compares and hashes arrays by their items, so a tuple is a good key.
			// Only getOption, set and invalidate use it, so it never calls the lookup.
			const cache = yield* Cache.makeWith<
				ReadonlyArray<string | undefined>,
				Cached
			>(() => Effect.die("The Discovery cache has no lookup"), {
				capacity: cacheCapacity,
				timeToLive: (exit) =>
					Exit.isSuccess(exit)
						? Duration.millis(exit.value.keepMillis)
						: Duration.zero,
			})
			const fetchDocument = Effect.fn("Discovery.fetchDocument")(function* (
				input: string,
				refresh: boolean = false,
			) {
				const url = yield* Schema.decodeEffect(Document.Link)(input)
				const accept = `${Document.cardMediaType}, ${Document.catalogMediaType}, text/html`
				const key = [
					network.identity.scope,
					network.identity.owner,
					url,
					accept,
				] as const
				const cached = yield* Cache.getOption(cache, key)
				const now = yield* Clock.currentTimeMillis
				const fresh = Option.filter(
					cached,
					(entry) => !refresh && entry.freshUntil > now,
				)
				if (Option.isSome(fresh))
					return {
						response: fresh.value.response,
						parsed: fresh.value.parsed,
					}
				const cachedHeaders = Option.match(cached, {
					onNone: () => ({}),
					onSome: (entry) =>
						Rec.filter(
							{
								"if-none-match": entry.response.headers["etag"],
								"if-modified-since": entry.response.headers["last-modified"],
							},
							Predicate.isNotUndefined,
						),
				})
				const received = yield* network.readDocument({
					url,
					headers: {
						...options.headersByOrigin?.[new URL(url).origin],
						accept,
						...cachedHeaders,
					},
				})
				const response =
					received.status === 304
						? yield* Option.match(cached, {
								onNone: () =>
									Effect.fail(
										DiscoveryError.make({
											reason: "Http",
											issues: [
												{
													url,
													reason: "304 without a validated cached copy",
												},
											],
										}),
									),
								onSome: (entry) =>
									Effect.succeed<Network.DocumentResponse>({
										...entry.response,
										headers: {
											...entry.response.headers,
											...received.headers,
										},
									}),
							})
						: received
				if (response.status !== 200)
					return yield* DiscoveryError.make({
						reason: "Http",
						issues: [
							{
								url,
								reason: `HTTP ${response.status}`,
							},
						],
					})
				const media = pipe(
					response.headers["content-type"] ?? "",
					Str.split(";"),
					Arr.headNonEmpty,
					Str.trim,
					Str.toLowerCase,
				)
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
						].includes(media))
				) {
					const links = pageLinks
					if (links.length === 0)
						return yield* DiscoveryError.make({
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
						Effect.mapError((e) =>
							DiscoveryError.make({
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
				const control = Str.toLowerCase(response.headers["cache-control"] ?? "")
				const maxAge = /(?:^|,)\s*max-age=(\d+)/.exec(control)?.[1]
				const freshUntil =
					pipe(control, Str.includes("no-cache")) || maxAge === undefined
						? now
						: now +
							Math.max(
								0,
								Number(maxAge) - Number(response.headers["age"] ?? "0"),
							) *
								1000
				// Without a validator, a stale entry cannot be used again.
				const validated =
					response.headers["etag"] !== undefined ||
					response.headers["last-modified"] !== undefined
				yield* pipe(control, Str.includes("no-store"))
					? Cache.invalidate(cache, key)
					: Cache.set(cache, key, {
							response,
							parsed,
							freshUntil,
							keepMillis: freshUntil - now + (validated ? staleKeepMillis : 0),
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
					return Candidate.make({
						cardUrl: options.cardUrl,
						card: options.card,
						endpoints: Arr.map(remotes, (remote) => ({
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
							...Arr.map(remotes, (remote) => ({
								role: "endpoint" as const,
								url: remote.url,
							})),
						],
					})
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
							DiscoveryError.make({
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
			const resolveInput = Effect.fn("Discovery.resolve")(
				function* (input: string) {
					const url = yield* rules.inputLink(input)
					let candidates = Chunk.empty<Candidate>()
					let issues: ReadonlyArray<Issue> = []
					let visited = HashSet.empty<string>()
					const visit = (
						url: string,
						sources: ReadonlyArray<Source>,
					): Effect.Effect<void, Error> =>
						Effect.gen(function* () {
							const identity = yield* Schema.decodeEffect(Document.Link)(url)
							if (HashSet.has(visited, identity)) return
							if (HashSet.size(visited) >= maxDocuments) {
								issues = Arr.append(
									issues,
									Issue.make({
										url: identity,
										reason: `Discovery stopped: one lookup reads at most ${maxDocuments} documents`,
									}),
								)
								return
							}
							visited = HashSet.add(visited, identity)
							const { response, parsed } = yield* fetchDocument(identity)
							return yield* Match.value(parsed).pipe(
								Match.tag("Card", ({ card }) =>
									Effect.gen(function* () {
										// `visited` lets each identity in only once, so a Card URL is never twice in the list.
										candidates = Chunk.append(
											candidates,
											yield* makeCandidate({
												cardUrl: identity,
												response,
												card,
												sources,
											}),
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
													urls: Arr.flatMap(parsed.catalog.entries, (entry) =>
														Match.value(entry.type).pipe(
															Match.whenOr(
																Document.cardMediaType,
																Document.catalogMediaType,
																() => {
																	if (entry.url !== undefined)
																		return [entry.url]
																	issues = Arr.append(
																		issues,
																		Issue.make({
																			url: response.url,
																			reason: `Inline-only entry ${entry.identifier} has no stable Card URL`,
																		}),
																	)
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
											Source.make({
												role,
												url: identity,
											}),
											...(response.url === identity
												? []
												: [
														Source.make({
															role,
															url: response.url,
														}),
													]),
										]
										if (urls.length > maxLinks)
											issues = Arr.append(
												issues,
												Issue.make({
													url: response.url,
													reason: `Discovery skipped ${urls.length - maxLinks} links: it follows at most ${maxLinks} links from one document`,
												}),
											)
										for (const target of Arr.take(urls, maxLinks)) {
											// One broken link is an issue of the result. It does not stop the other links.
											yield* visit(target, chain).pipe(
												Effect.catch((failure) =>
													Effect.sync(() => {
														issues = Arr.appendAll(
															issues,
															failureIssues(target, failure),
														)
													}),
												),
											)
										}
									}),
								),
							)
						})
					yield* visit(url, [
						Source.make({
							role: "input",
							url,
							originalInput: input,
						}),
					])
					return yield* Arr.matchLeft(Chunk.toReadonlyArray(candidates), {
						onEmpty: () =>
							Effect.fail(
								DiscoveryError.make({
									reason: "NoUsableServices",
									issues,
								}),
							),
						onNonEmpty: (first, rest) =>
							Effect.succeed<Result>(
								Arr.matchLeft(rest, {
									onEmpty: () => ({
										_tag: "Single" as const,
										candidate: first,
										issues,
									}),
									onNonEmpty: (second, others) => ({
										_tag: "Multiple" as const,
										candidates: [first, second, ...others],
										issues,
									}),
								}),
							),
					})
				},
				// A Catalog can link to many slow documents, so the whole lookup has a deadline.
				Effect.timeoutOrElse({
					duration: resolveDeadline,
					orElse: () =>
						Effect.fail(
							Network.NetworkError.make({
								reason: "Timeout",
								message: "Discovery did not finish in time",
							}),
						),
				}),
			)
			return Discovery.of({
				resolve: resolveInput,
				refreshCard: (url) =>
					fetchCard(url, [Source.make({ role: "input", url })], true),
				refresh: (previous) =>
					fetchCard(
						previous.cardUrl,
						[
							Source.make({
								role: "input",
								url: previous.cardUrl,
							}),
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
	pipe(
		s,
		Str.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g),
		Arr.fromIterable,
		Arr.map((m) => m[1]),
		Arr.filter(Predicate.isNotUndefined),
	)

const requirement = (
	key: string,
	input: Document.Input | Document.HeaderInput,
): ConfigurationRequirement =>
	ConfigurationRequirement.make({
		key,
		description: input.description,
		isSecret: input.isSecret === true,
		format: input.format,
		choices: input.choices,
	})

/** A variable needs a value from the user when nothing in the Card gives one. */
const variableRequirements = (options: {
	readonly prefix: string
	readonly template: string
	readonly variables: Readonly<Record<string, Document.Input>> | undefined
	readonly isSecret: boolean
}): ReadonlyArray<ConfigurationRequirement> => {
	const referenced = referencedVariables(options.template)
	const declared = Arr.flatMap(
		Rec.toEntries(options.variables ?? {}),
		([name, input]) =>
			(input.isRequired === true || referenced.includes(name)) &&
			input.value === undefined &&
			input.default === undefined
				? [requirement(`${options.prefix}${name}`, input)]
				: [],
	)
	const undeclared = Arr.flatMap(referenced, (name) =>
		options.variables?.[name] === undefined
			? [
					ConfigurationRequirement.make({
						key: `${options.prefix}${name}`,
						isSecret: options.isSecret,
					}),
				]
			: [],
	)
	return [...declared, ...undeclared]
}

export const requirements = (
	remote: Document.Remote,
): ReadonlyArray<ConfigurationRequirement> => [
	...variableRequirements({
		prefix: "variable:",
		template: remote.url,
		variables: remote.variables,
		isSecret: false,
	}),
	...Arr.flatMap(remote.headers ?? [], (header) => [
		...(header.isRequired === true &&
		header.value === undefined &&
		header.default === undefined
			? [requirement(`header:${header.name}`, header)]
			: []),
		...variableRequirements({
			prefix: `header:${header.name}:variable:`,
			template: header.value ?? "",
			variables: header.variables,
			isSecret: header.isSecret === true,
		}),
	]),
]

export const layerRules = Layer.succeed(Rules, {
	compare,
	inputLink,
	configureEndpoint,
	catalogLinks,
	requirements,
})
