import {
	Array as Arr,
	Cache,
	Cause,
	Option,
	Clock,
	Duration,
	Effect,
	Exit,
	Layer,
	Schema,
	Match,
	pipe,
	Predicate,
	Result,
	Record as Rec,
	String as Str,
} from "effect"
import { Rules } from "../discovery/Discovery.ts"

import * as Index from "./Index.ts"
import * as Client from "../connections/Client.ts"
import * as Document from "../Document.ts"
import * as Network from "../network/Network.ts"
import * as Robots from "../discovery/Robots.ts"
import {
	IndexingError,
	Input,
	SyncResult,
	Indexing,
	PublicationInspection,
	type InspectionResult,
	InspectionStage,
} from "./Indexing.ts"

interface Cached {
	readonly response: Network.DocumentResponse
	readonly freshUntil: number
	/** How long the cache keeps this entry. */
	readonly keepMillis: number
}

/** The cache drops the least recently used document when it has more. */
const cacheCapacity = 256
/** A stale document with an ETag or Last-Modified stays this much longer, so a later read can revalidate it. */
const staleKeepMillis = 86_400_000
/** One inspection reads at most this many publisher Catalogs. The Card origin comes first. */
const maxProbes = 8
/** One inspection must end in this time. */
const verifyDeadline = "60 seconds"

interface Probe {
	readonly publisherUrl: string
	readonly catalogUrl: string
	readonly association: Index.Evidence["association"]
}

const cacheExpiry = (
	response: Network.DocumentResponse,
	now: number,
	robots: boolean,
) => {
	const control = response.headers["cache-control"] ?? ""
	if (/\b(?:no-cache|no-store)\b/i.test(control)) return now
	const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(control)
	const duration = maxAge === null ? (robots ? 3600 : 0) : Number(maxAge[1])
	const age = Number(response.headers["age"] ?? "0")
	const date = Date.parse(response.headers["date"] ?? "")
	const elapsed = Number.isFinite(date) ? Math.max(0, (now - date) / 1000) : 0
	return (
		now +
		Math.max(
			0,
			Math.min(robots ? 86400 : duration, duration) -
				Math.max(Number.isFinite(age) ? age : 0, elapsed),
		) *
			1000
	)
}

const noindex = (header: string | undefined) => {
	let applies = true
	for (const part of pipe(header ?? "", Str.toLowerCase, Str.split(","))) {
		const scoped = /^\s*([a-z_-]+)\s*:\s*(.*)$/.exec(part)
		if (scoped !== null)
			applies = scoped[1] === Str.toLowerCase(Network.publicProductToken)
		if (
			applies &&
			/(?:^|\s)(?:noindex|none)(?:\s|$)/.test(scoped?.[2] ?? Str.trim(part))
		)
			return true
	}
	return false
}

/** The background Scope of the host owns this anonymous cache, apart from Discovery. */
export const makeInspection: Effect.Effect<
	typeof PublicationInspection.Service,
	never,
	Network.PublicNetwork | Rules | Robots.Robots
> = Effect.gen(function* () {
	const network = yield* Network.PublicNetwork
	const rules = yield* Rules
	const policy = yield* Robots.Robots
	// Only getOption, set and invalidate use the cache, so it never calls the lookup.
	const cache = yield* Cache.makeWith<string, Cached>(
		() => Effect.die("The Indexing cache has no lookup"),
		{
			capacity: cacheCapacity,
			timeToLive: (exit) =>
				Exit.isSuccess(exit)
					? Duration.millis(exit.value.keepMillis)
					: Duration.zero,
		},
	)
	const readHop = Effect.fn("Indexing.readHop")(function* (
		url: string,
		robots: boolean,
	) {
		const now = yield* Clock.currentTimeMillis
		const cached = yield* Cache.getOption(cache, url)
		const fresh = Option.filter(
			cached,
			(entry) => robots && entry.freshUntil > now,
		)
		if (Option.isSome(fresh)) return fresh.value.response
		const reply = yield* network.readDocument({
			url,
			followRedirects: false,
			...Option.match(cached, {
				onNone: () => ({}),
				onSome: (entry) => ({
					validators: Rec.filter(
						{
							etag: entry.response.headers["etag"],
							lastModified: entry.response.headers["last-modified"],
						},
						Predicate.isNotUndefined,
					),
				}),
			}),
		})
		if (reply.url !== url)
			return yield* IndexingError.make({
				url,
				reason: "Redirect",
				issue:
					"Public adapter followed a redirect before robots could be checked",
			})
		if (reply.status !== 304) return reply
		// The consumer below caches only responses that it parsed successfully.
		return yield* Option.match(cached, {
			onNone: () =>
				Effect.fail(
					IndexingError.make({
						url,
						reason: "InvalidDocument",
						issue: "304 has no validated anonymous cached copy",
					}),
				),
			onSome: (entry) =>
				Effect.succeed<Network.DocumentResponse>({
					...entry.response,
					headers: {
						...entry.response.headers,
						...reply.headers,
					},
				}),
		})
	})
	const remember = Effect.fn("Indexing.remember")(function* (
		response: Network.DocumentResponse,
		robots: boolean,
	) {
		const now = yield* Clock.currentTimeMillis
		const freshUntil = cacheExpiry(response, now, robots)
		const validated =
			response.headers["etag"] !== undefined ||
			response.headers["last-modified"] !== undefined
		// Only robots.txt uses freshness. Other documents serve only as validators,
		// so without a validator they are not kept.
		yield* /\bno-store\b/i.test(response.headers["cache-control"] ?? "")
			? Cache.invalidate(cache, response.url)
			: Cache.set(cache, response.url, {
					response,
					freshUntil,
					keepMillis: validated
						? freshUntil - now + staleKeepMillis
						: robots
							? freshUntil - now
							: 0,
				})
	})
	const robots = Effect.fn("Indexing.robots")(function* (target: string) {
		const original = new URL("/robots.txt", target).href
		const follow = (
			url: string,
			hop: number,
		): Effect.Effect<
			void,
			Network.NetworkError | Schema.SchemaError | IndexingError
		> =>
			Effect.gen(function* () {
				const response = yield* readHop(url, true)
				if ([301, 302, 303, 307, 308].includes(response.status)) {
					if (hop >= 5 || response.headers["location"] === undefined)
						return yield* IndexingError.make({
							url: original,
							reason: "RobotsUnavailable",
							issue: "Could not reach robots.txt within five redirects",
						})
					const location = response.headers["location"]
					if (!URL.canParse(location, url))
						return yield* IndexingError.make({
							url: original,
							reason: "RobotsUnavailable",
							issue: "robots.txt has an invalid redirect",
						})
					const next = yield* Schema.decodeEffect(Document.Link)(
						new URL(location, url).href,
					)
					return yield* follow(next, hop + 1)
				}
				if (response.status >= 400 && response.status < 500) {
					yield* remember({ ...response, url: original }, true)
					return
				}
				if (response.status < 200 || response.status >= 300)
					return yield* IndexingError.make({
						url: original,
						reason: "RobotsUnavailable",
						issue: "robots.txt is unreachable",
					})
				const mediaType = pipe(
					response.headers["content-type"] ?? "",
					Str.split(";"),
					Arr.headNonEmpty,
					Str.trim,
					Str.toLowerCase,
				)
				if (mediaType !== "text/plain")
					return yield* IndexingError.make({
						url: original,
						reason: "RobotsUnavailable",
						issue: "robots.txt is not text/plain",
					})
				yield* remember(response, true)
				// A redirected file applies to the original authority (host and port), never to the final one.
				if (
					!policy.allowed({
						text: response.text,
						productToken: Network.publicProductToken,
						url: target,
					})
				)
					return yield* IndexingError.make({
						url: target,
						reason: "RobotsDenied",
						issue: "robots.txt disallows this document",
					})
				return
			})
		return yield* follow(original, 0)
	})
	const read = Effect.fn("Indexing.readDocument")(function* (input: string) {
		const follow = (
			url: string,
			hop: number,
		): Effect.Effect<
			Network.DocumentResponse,
			Network.NetworkError | Schema.SchemaError | IndexingError
		> =>
			Effect.gen(function* () {
				yield* robots(url)
				const response = yield* readHop(url, false)
				if (![301, 302, 303, 307, 308].includes(response.status))
					return response
				const location = response.headers["location"]
				// A bad Location header is a typed failure, not a defect from `new URL`.
				if (hop >= 5 || location === undefined || !URL.canParse(location, url))
					return yield* IndexingError.make({
						url,
						reason: "Redirect",
						issue: "Invalid document redirect",
					})
				const next = yield* Schema.decodeEffect(Document.Link)(
					new URL(location, url).href,
				)
				return yield* follow(next, hop + 1)
			})
		return yield* follow(yield* Schema.decodeEffect(Document.Link)(input), 0)
	})
	const fetchCatalog = Effect.fn("Indexing.catalog")(function* (
		catalogUrl: string,
		cardUrl: string,
	) {
		const response = yield* read(catalogUrl)
		if (response.status === 404 || response.status === 410)
			return { found: false, declared: false }
		if (response.status !== 200)
			return yield* IndexingError.make({
				url: catalogUrl,
				reason: "Unavailable",
				issue: "Publisher Catalog is not anonymously available",
			})
		const catalog = yield* Schema.decodeEffect(
			Schema.fromJsonString(Document.Catalog),
		)(response.text)
		yield* remember(response, false)
		for (const entry of Arr.filter(
			catalog.entries,
			(entry) => entry.type === Document.cardMediaType,
		)) {
			// An entry with a URL that cannot be read is not the card.
			if (entry.url === undefined || !URL.canParse(entry.url, response.url))
				continue
			const link = yield* Schema.decodeEffect(Document.Link)(
				new URL(entry.url, response.url).href,
			)
			if (link === cardUrl) return { found: true, declared: true }
		}
		return { found: false, declared: true }
	})
	return PublicationInspection.of({
		inspect: Effect.fn("PublicationInspection.inspect")(
			function* (value, previous) {
				const input = yield* Input.decode(value)
				const stageNames: ReadonlyArray<InspectionStage["name"]> = [
					"CardRead",
					"CardSchema",
					"Compatibility",
					"PublisherAssociation",
					"Eligibility",
				]
				let stages: ReadonlyArray<InspectionStage> = Arr.map(
					stageNames,
					(name) => ({
						name,
						source: input.cardUrl,
						status: "NotChecked",
					}),
				)
				const stage = (
					name: InspectionStage["name"],
					status: InspectionStage["status"],
					source = input.cardUrl,
					reason?: string,
				) =>
					Clock.currentTimeMillis.pipe(
						Effect.flatMap((checkedAt) =>
							Effect.sync(() => {
								stages = Arr.map(stages, (value) =>
									value.name === name
										? {
												name,
												status,
												source,
												checkedAt,
												...(reason === undefined ? {} : { reason }),
											}
										: value,
								)
							}),
						),
					)
				const exclude = (
					reason: string,
					withdraw: boolean,
				): Effect.Effect<InspectionResult> =>
					Effect.gen(function* () {
						yield* stage("Eligibility", "Failed", input.cardUrl, reason)
						if (
							reason === "NoPublisherDeclaration" ||
							reason === "DeclarationWithdrawn"
						)
							yield* stage(
								"PublisherAssociation",
								"Failed",
								input.cardUrl,
								reason,
							)
						return {
							_tag: "Excluded",
							stages,
							cardUrl: input.cardUrl,
							reason,
							withdraw,
						} satisfies InspectionResult
					})
				const verify = Effect.gen(function* () {
					yield* stage("CardRead", "Unconfirmed")
					const response = yield* read(input.cardUrl)
					if (response.status !== 200)
						return yield* IndexingError.make({
							url: input.cardUrl,
							reason: "Unavailable",
							issue: "Card is not anonymously available",
						})
					yield* stage("CardRead", "Passed", response.url)
					if (noindex(response.headers["x-robots-tag"]))
						return yield* exclude("NoIndex", true)
					yield* stage("CardSchema", "Unconfirmed", response.url)
					const card = yield* Schema.decodeEffect(
						Schema.fromJsonString(Document.ServerCard),
					)(response.text)
					yield* stage("CardSchema", "Passed", response.url)
					yield* stage("Compatibility", "Unconfirmed", response.url)
					yield* Document.compatibleRemotes(card)
					yield* stage("Compatibility", "Passed", response.url)
					yield* stage("PublisherAssociation", "Unconfirmed", response.url)
					yield* remember(response, false)
					const cardOrigin = new URL(response.url).origin
					let probes: ReadonlyArray<Probe> = [
						{
							publisherUrl: cardOrigin,
							catalogUrl: cardOrigin + "/.well-known/ai-catalog.json",
							association: "CardOrigin",
						},
					]
					for (const link of Arr.take(
						rules.catalogLinks({
							responseUrl: response.url,
							link: response.headers["link"],
						}),
						maxProbes,
					))
						probes = Arr.append(probes, {
							publisherUrl: link,
							catalogUrl: link,
							association: "CardLink",
						})
					let evidence: ReadonlyArray<Index.Evidence> = []
					let failures: ReadonlyArray<
						| IndexingError
						| Network.NetworkError
						| Schema.SchemaError
						| Document.InvalidDocument
						| Document.IncompatibleCard
					> = []
					const websiteUrl = card.websiteUrl
					if (websiteUrl !== undefined) {
						const website = yield* Effect.result(
							Effect.gen(function* () {
								const url = yield* Schema.decodeEffect(Document.Link)(
									websiteUrl,
								)
								const page = yield* read(url)
								if (page.status !== 200)
									return yield* IndexingError.make({
										url,
										reason: "Unavailable",
										issue: "Publisher website is not anonymously available",
									})
								const links = rules.catalogLinks({
									responseUrl: page.url,
									link: page.headers["link"],
									html: page.text,
								})
								return {
									url,
									links: [
										...Arr.take(links, maxProbes - 1),
										new URL("/.well-known/ai-catalog.json", page.url).href,
									],
								}
							}),
						)
						Match.value(website).pipe(
							Match.tagsExhaustive({
								Failure: ({ failure }) => {
									failures = Arr.append(failures, failure)
								},
								Success: ({ success }) => {
									for (const link of Arr.dedupe(success.links))
										probes = Arr.append(probes, {
											publisherUrl: success.url,
											catalogUrl: link,
											association: "Website",
										})
								},
							}),
						)
					}
					let withdrawn = Option.exists(previous, (value) =>
						Arr.every(
							value.evidence,
							(item) =>
								!Arr.some(
									probes,
									(probe) =>
										probe.catalogUrl === item.catalogUrl &&
										probe.association === item.association,
								),
						),
					)
					// Read each Catalog once, also when more than one probe names it.
					const catalogUrls = pipe(
						probes,
						Arr.map((probe) => probe.catalogUrl),
						Arr.dedupe,
						Arr.take(maxProbes),
					)
					for (const catalogUrl of catalogUrls) {
						const checked = yield* Effect.result(
							fetchCatalog(catalogUrl, input.cardUrl),
						)
						yield* Match.value(checked).pipe(
							Match.tagsExhaustive({
								Failure: ({ failure }) =>
									Effect.sync(() => {
										failures = Arr.append(failures, failure)
									}),
								Success: ({ success }) =>
									Effect.forEach(
										Arr.filter(
											probes,
											(probe) => probe.catalogUrl === catalogUrl,
										),
										(probe) =>
											Effect.gen(function* () {
												if (success.found)
													evidence = Arr.append(
														evidence,
														yield* Index.Evidence.decode({
															...probe,
															cardUrl: input.cardUrl,
														}),
													)
												else if (
													Option.exists(previous, (value) =>
														Arr.some(
															value.evidence,
															(item) => item.catalogUrl === probe.catalogUrl,
														),
													)
												) {
													if (success.declared) withdrawn = true
													else
														failures = Arr.append(
															failures,
															IndexingError.make({
																url: probe.catalogUrl,
																reason: "Unavailable",
																issue:
																	"Previously verified publisher Catalog is no longer available",
															}),
														)
												}
											}),
										{ discard: true },
									),
							}),
						)
					}
					if (!Arr.isReadonlyArrayNonEmpty(evidence)) {
						if (withdrawn) return yield* exclude("DeclarationWithdrawn", true)
						const failure = failures[0]
						if (failure !== undefined) return yield* failure
						return yield* exclude("NoPublisherDeclaration", false)
					}
					yield* stage(
						"PublisherAssociation",
						"Passed",
						Arr.headNonEmpty(evidence).catalogUrl,
					)
					const entry = yield* Index.Entry.decode({
						cardUrl: input.cardUrl,
						card,
						evidence,
						checkedAt: yield* Clock.currentTimeMillis,
						validators: Rec.filter(
							{
								etag: response.headers["etag"],
								lastModified: response.headers["last-modified"],
							},
							Predicate.isNotUndefined,
						),
					})
					yield* stage("Eligibility", "Passed")
					return {
						_tag: "Eligible",
						entry,
						stages,
					} as const
				})
				return yield* verify.pipe(
					// Many probes and redirects can be slow, so the whole check has a deadline.
					Effect.timeoutOrElse({
						duration: verifyDeadline,
						orElse: () =>
							Effect.fail(
								Network.NetworkError.make({
									reason: "Timeout",
									message: "Anonymous verification did not finish in time",
								}),
							),
					}),
					Effect.catchCause((cause) => {
						if (Cause.hasDies(cause))
							return Effect.failCause(cause).pipe(Effect.orDie)
						return Cause.findError(cause).pipe(
							Result.match({
								onFailure: Effect.failCause,
								onSuccess: (error) =>
									Match.value(error).pipe(
										Match.when(
											{ _tag: "IndexingError", reason: "RobotsDenied" },
											() => exclude("RobotsDenied", false),
										),
										Match.orElse((error) =>
											Effect.succeed<InspectionResult>(
												Client.withCause(
													{
														_tag: "Unconfirmed" as const,
														stages,
														cardUrl: input.cardUrl,
														...Match.value(error).pipe(
															Match.tagsExhaustive({
																IndexingError: (error) => ({
																	reason: error.reason,
																	url: error.url,
																	issue:
																		"The public App declaration could not be checked.",
																}),
																NetworkError: (error) => ({
																	reason: error.reason,
																	url: input.cardUrl,
																	issue:
																		"The public App address could not be read.",
																}),
																SchemaError: () => ({
																	reason: "InvalidDocument",
																	url: input.cardUrl,
																	issue:
																		"The public App document does not match its schema.",
																}),
																IncompatibleCard: () => ({
																	reason: "InvalidDocument",
																	url: input.cardUrl,
																	issue:
																		"The public App Card has no supported connection.",
																}),
																InvalidDocument: () => ({
																	reason: "InvalidDocument",
																	url: input.cardUrl,
																	issue:
																		"The public App document is not valid.",
																}),
																IndexError: () => ({
																	reason: "InvalidDocument",
																	url: input.cardUrl,
																	issue: "The Index entry is not valid.",
																}),
															}),
														),
													},
													cause,
												),
											),
										),
									),
							}),
						)
					}),
				)
			},
		),
	})
})

export const layerInspection = Layer.effect(
	PublicationInspection,
	makeInspection,
)

/** Sync the same evidence that the read-only inspection service checks. */
export const layer = Layer.effect(
	Indexing,
	Effect.gen(function* () {
		const index = yield* Index.IndexStore
		const inspection = yield* PublicationInspection
		return Indexing.of({
			sync: Effect.fn("Indexing.sync")(function* (input) {
				const previous = yield* index.get(input.cardUrl)
				const result = yield* inspection.inspect(input, previous)
				return yield* Match.value(result).pipe(
					Match.tagsExhaustive({
						Eligible: ({ entry }) =>
							index
								.upsert(entry)
								.pipe(
									Effect.map(
										(entry) =>
											({ _tag: "Indexed", entry }) satisfies SyncResult,
									),
								),
						Excluded: ({ cardUrl, reason, withdraw }) =>
							withdraw && Option.isSome(previous)
								? index.withdraw(cardUrl).pipe(
										Effect.as({
											_tag: "Withdrawn",
											cardUrl,
											reason,
										} satisfies SyncResult),
									)
								: Effect.succeed({
										_tag: "Excluded",
										cardUrl,
										reason,
									} satisfies SyncResult),
						Unconfirmed: (result) => Effect.succeed(result),
					}),
				)
			}),
		})
	}),
).pipe(Layer.provide(layerInspection))
