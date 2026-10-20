import {
	Array as EffectArray,
	Option,
	HashMap,
	Clock,
	Effect,
	Layer,
	Ref,
	Schema,
	Match,
	Predicate,
	Record,
} from "effect"
import { Rules } from "../discovery/Discovery.ts"

import * as Index from "./Index.ts"
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
}

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
	for (const part of (header ?? "").toLowerCase().split(",")) {
		const scoped = /^\s*([a-z_-]+)\s*:\s*(.*)$/.exec(part)
		if (scoped !== null)
			applies = scoped[1] === Network.publicProductToken.toLowerCase()
		if (
			applies &&
			/(?:^|\s)(?:noindex|none)(?:\s|$)/.test(scoped?.[2] ?? part.trim())
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
	const cache = yield* Ref.make(HashMap.empty<string, Cached>())
	const documentError = (
		url: string,
		reason: IndexingError["reason"],
		issue: string,
	) => new IndexingError({ url, reason, issue })
	const readHop = Effect.fn("Indexing.readHop")(function* (
		url: string,
		robots: boolean,
	) {
		const now = yield* Clock.currentTimeMillis
		const cached = Option.getOrUndefined(
			HashMap.get(yield* Ref.get(cache), url),
		)
		if (robots && cached !== undefined && cached.freshUntil > now)
			return cached.response
		const reply = yield* network.readDocument({
			url,
			followRedirects: false,
			...(cached === undefined
				? {}
				: {
						validators: Record.filter(
							{
								etag: cached.response.headers["etag"],
								lastModified: cached.response.headers["last-modified"],
							},
							Predicate.isNotUndefined,
						),
					}),
		})
		if (reply.url !== url)
			return yield* documentError(
				url,
				"Redirect",
				"Public adapter followed a redirect before robots could be checked",
			)
		let response = reply
		if (reply.status === 304) {
			if (cached === undefined)
				return yield* documentError(
					url,
					"InvalidDocument",
					"304 has no validated anonymous cached copy",
				)
			response = {
				...cached.response,
				headers: {
					...cached.response.headers,
					...reply.headers,
				},
			}
		}
		// The consumer below caches only responses that it parsed successfully.
		return response
	})
	const remember = Effect.fn("Indexing.remember")(function* (
		response: Network.DocumentResponse,
		robots: boolean,
	) {
		const now = yield* Clock.currentTimeMillis
		yield* Ref.update(cache, (entries) => {
			let next = entries
			if (/\bno-store\b/i.test(response.headers["cache-control"] ?? ""))
				next = HashMap.remove(next, response.url)
			else
				next = HashMap.set(next, response.url, {
					response,
					freshUntil: cacheExpiry(response, now, robots),
				})
			return next
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
						return yield* documentError(
							original,
							"RobotsUnavailable",
							"Could not reach robots.txt within five redirects",
						)
					const next = yield* Schema.decodeEffect(Document.Link)(
						new URL(response.headers["location"], url).href,
					)
					return yield* follow(next, hop + 1)
				}
				if (response.status >= 400 && response.status < 500) {
					yield* remember({ ...response, url: original }, true)
					return
				}
				if (response.status < 200 || response.status >= 300)
					return yield* documentError(
						original,
						"RobotsUnavailable",
						"robots.txt is unreachable",
					)
				if (
					response.headers["content-type"]
						?.split(";", 1)[0]
						?.trim()
						.toLowerCase() !== "text/plain"
				)
					return yield* documentError(
						original,
						"RobotsUnavailable",
						"robots.txt is not text/plain",
					)
				yield* remember(response, true)
				// A redirected file applies to the original authority (host and port), never to the final one.
				if (
					!policy.allowed({
						text: response.text,
						productToken: Network.publicProductToken,
						url: target,
					})
				)
					return yield* documentError(
						target,
						"RobotsDenied",
						"robots.txt disallows this document",
					)
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
				if (hop >= 5 || response.headers["location"] === undefined)
					return yield* documentError(
						url,
						"Redirect",
						"Invalid document redirect",
					)
				const next = yield* Schema.decodeEffect(Document.Link)(
					new URL(response.headers["location"], url).href,
				)
				return yield* follow(next, hop + 1)
			})
		return yield* follow(yield* Schema.decodeEffect(Document.Link)(input), 0)
	})
	const fetchCatalog = Effect.fn("Indexing.catalog")(function* (
		probe: Probe,
		cardUrl: string,
	) {
		const response = yield* read(probe.catalogUrl)
		if (response.status === 404 || response.status === 410)
			return { found: false, declared: false }
		if (response.status !== 200)
			return yield* documentError(
				probe.catalogUrl,
				"Unavailable",
				"Publisher Catalog is not anonymously available",
			)
		const catalog = yield* Schema.decodeEffect(
			Schema.fromJsonString(Document.Catalog),
		)(response.text)
		yield* remember(response, false)
		for (const entry of catalog.entries.filter(
			(entry) => entry.type === Document.cardMediaType,
		)) {
			if (entry.url === undefined) continue
			const link = yield* Schema.decodeEffect(Document.Link)(
				new URL(entry.url, response.url).href,
			)
			if (link === cardUrl) return { found: true, declared: true }
		}
		return { found: false, declared: true }
	})
	return PublicationInspection.of({
		inspect: Effect.fn("PublicationInspection.inspect")(
			function* (value, prior) {
				const input = yield* Input.decode(value)
				const previous = Option.fromNullishOr(prior)
				const stageNames: ReadonlyArray<InspectionStage["name"]> = [
					"CardRead",
					"CardSchema",
					"Compatibility",
					"PublisherAssociation",
					"Eligibility",
				]
				let stages: ReadonlyArray<InspectionStage> = stageNames.map((name) =>
					Schema.decodeSync(InspectionStage)({
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
								stages = stages.map((value) =>
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
						return yield* documentError(
							input.cardUrl,
							"Unavailable",
							"Card is not anonymously available",
						)
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
					for (const link of rules.catalogLinks({
						responseUrl: response.url,
						link: response.headers["link"],
					}))
						probes = EffectArray.append(probes, {
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
					if (card.websiteUrl !== undefined) {
						const website = yield* Effect.result(
							Effect.gen(function* () {
								const url = yield* Schema.decodeEffect(Document.Link)(
									card.websiteUrl!,
								)
								const page = yield* read(url)
								if (page.status !== 200)
									return yield* documentError(
										url,
										"Unavailable",
										"Publisher website is not anonymously available",
									)
								const links = rules.catalogLinks({
									responseUrl: page.url,
									link: page.headers["link"],
									html: page.text,
								})
								return {
									url,
									links: [
										...links,
										new URL("/.well-known/ai-catalog.json", page.url).href,
									],
								}
							}),
						)
						Match.value(website).pipe(
							Match.tagsExhaustive({
								Failure: ({ failure }) => {
									failures = EffectArray.append(failures, failure)
								},
								Success: ({ success }) => {
									for (const link of EffectArray.dedupe(success.links))
										probes = EffectArray.append(probes, {
											publisherUrl: success.url,
											catalogUrl: link,
											association: "Website",
										})
								},
							}),
						)
					}
					let withdrawn = Match.value(previous).pipe(
						Match.tag("Some", ({ value }) =>
							value.evidence.every(
								(item) =>
									!probes.some(
										(probe) =>
											probe.catalogUrl === item.catalogUrl &&
											probe.association === item.association,
									),
							),
						),
						Match.orElse(() => false),
					)
					for (const probe of probes) {
						const checked = yield* Effect.result(
							fetchCatalog(probe, input.cardUrl),
						)
						yield* Match.value(checked).pipe(
							Match.tagsExhaustive({
								Failure: ({ failure }) =>
									Effect.sync(() => {
										failures = EffectArray.append(failures, failure)
									}),
								Success: ({ success }) =>
									Effect.gen(function* () {
										if (success.found)
											evidence = EffectArray.append(
												evidence,
												yield* Index.Evidence.decode({
													...probe,
													cardUrl: input.cardUrl,
												}),
											)
										else
											Match.value(previous).pipe(
												Match.tag("Some", ({ value }) => {
													if (
														value.evidence.some(
															(item) => item.catalogUrl === probe.catalogUrl,
														)
													) {
														if (success.declared) withdrawn = true
														else
															failures = EffectArray.append(
																failures,
																documentError(
																	probe.catalogUrl,
																	"Unavailable",
																	"Previously verified publisher Catalog is no longer available",
																),
															)
													}
												}),
												Match.orElse(() => undefined),
											)
									}),
							}),
						)
					}
					if (evidence.length === 0) {
						if (withdrawn) return yield* exclude("DeclarationWithdrawn", true)
						const failure = failures[0]
						if (failure !== undefined) return yield* failure
						return yield* exclude("NoPublisherDeclaration", false)
					}
					yield* stage(
						"PublisherAssociation",
						"Passed",
						evidence[0]!.catalogUrl,
					)
					const entry = yield* Index.Entry.decode({
						cardUrl: input.cardUrl,
						card,
						evidence,
						checkedAt: yield* Clock.currentTimeMillis,
						validators: Record.filter(
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
					Effect.catch((error) =>
						Match.value(error).pipe(
							Match.when(
								{ _tag: "IndexingError", reason: "RobotsDenied" },
								() => exclude("RobotsDenied", false),
							),
							Match.orElse((error) =>
								Effect.succeed<InspectionResult>({
									_tag: "Unconfirmed" as const,
									stages,
									cardUrl: input.cardUrl,
									...Match.value(error).pipe(
										Match.tag("IndexingError", (error) => ({
											reason: error.reason,
											url: error.url,
											issue: error.issue,
										})),
										Match.tag("NetworkError", (error) => ({
											reason: error.reason,
											url: input.cardUrl,
											issue: "Anonymous verification did not finish",
										})),
										Match.orElse(() => ({
											reason: "InvalidDocument",
											url: input.cardUrl,
											issue: "Anonymous verification did not finish",
										})),
									),
								}),
							),
						),
					),
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
				const result = yield* inspection.inspect(
					input,
					Option.getOrUndefined(previous),
				)
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
