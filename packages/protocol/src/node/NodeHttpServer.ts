import {
	Array as EffectArray,
	Effect,
	Exit,
	Layer,
	Option,
	Schema,
	Scope,
	Stream,
	Match,
	Predicate,
	Record as RecordUtils,
} from "effect"
import * as HttpNetwork from "../network/HttpNetwork.ts"
import { type PublicOptions, type UserOptions } from "./Node.ts"
import { NodeHttpClient, NodeStream } from "@effect/platform-node"

import { HttpClient, HttpClientRequest } from "effect/http"
import { IpNetwork, NetAddress } from "effect/net"
import { lookup } from "node:dns"
import { type LookupFunction } from "node:net"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import * as Document from "../Document.ts"
import * as Network from "../network/Network.ts"

const blocked = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"168.63.129.16/32",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"2001:db8::/32",
	"2001::/32",
	"2002::/16",
].map(IpNetwork.fromStringUnsafe)
const globalV6 = IpNetwork.fromStringUnsafe("2000::/3")

/** Also rejects mapped IPv4, local IPv6, transition ranges and metadata addresses. */
export const isPublicAddress = (input: string): boolean => {
	const parsed = NetAddress.ipFromString(input.replace(/^\[|\]$/g, ""))
	return Match.value(parsed).pipe(
		Match.tagsExhaustive({
			Failure: () => false,
			Success: ({ success }) => {
				const address = NetAddress.toCanonical(success)
				if (
					NetAddress.isIpv6Address(address) &&
					!IpNetwork.contains(globalV6, address)
				)
					return false
				return !blocked.some((network) => IpNetwork.contains(network, address))
			},
		}),
	)
}

/** The rules that differ between the public network and a user network. */
interface Guard {
	readonly identity: typeof Network.Network.Service.identity
	readonly allowAddress: (address: string, hostname: string) => boolean
	/** None means that every public origin is allowed. */
	readonly allowedOrigins: Option.Option<ReadonlyArray<string>>
}

const layerNetwork = (options: PublicOptions, guard: Guard) => {
	const allow = guard.allowAddress
	const resolver = options.lookup ?? lookup
	const maxRedirects = options.maxRedirects ?? 5
	const maxBytes = options.maxBytes ?? 1024 * 1024
	const timeoutMs = options.timeoutMs ?? 10_000
	const guardedLookup: LookupFunction = (hostname, requested, callback) => {
		resolver(
			hostname,
			{
				all: true,
				family: Predicate.isNumber(requested)
					? requested
					: (requested.family ?? 0),
			},
			(error, addresses) => {
				if (error !== null) {
					callback(error, "", 4)
					return
				}
				if (
					!EffectArray.isReadonlyArrayNonEmpty(addresses) ||
					addresses.some((a) => !allow(a.address, hostname))
				) {
					callback(
						new Network.NetworkError({
							reason: "BlockedTarget",
							message: "DNS resolved to a forbidden connection address",
						}),
						"",
						4,
					)
					return
				}
				if (Predicate.isObjectOrArray(requested) && requested.all === true) {
					callback(null, addresses)
					return
				}
				const first = EffectArray.headNonEmpty(addresses)
				callback(null, first.address, first.family)
			},
		)
	}
	const layerClient = NodeHttpClient.layerNodeHttpNoAgent.pipe(
		Layer.provide(
			NodeHttpClient.layerAgentOptions({
				lookup: guardedLookup,
				...RecordUtils.filter({ ca: options.ca }, Predicate.isNotUndefined),
				// Resolve DNS for every new connection, so checked addresses stay bound to that socket.
				keepAlive: false,
			}),
		),
		// Without this, native HTTP Layers share memoized clients between networks with different guards.
		Layer.fresh,
	)
	return Layer.effect(
		Network.Network,
		Effect.gen(function* () {
			const http = HttpClient.withScope(yield* HttpClient.HttpClient)
			const check = Effect.fn("Node.checkTarget")(function* (input: string) {
				const normalized = yield* Schema.decodeEffect(Document.Link)(input)
				const url = new URL(normalized)
				if (
					Option.exists(
						guard.allowedOrigins,
						(origins) => !origins.includes(url.origin),
					)
				) {
					return yield* new Network.NetworkError({
						reason: "BlockedTarget",
						message: "Origin is not permitted in this user network",
					})
				}
				const host = url.hostname.replace(/^\[|\]$/g, "")
				yield* Match.value(NetAddress.ipFromString(host)).pipe(
					Match.tag("Success", () =>
						allow(host, host)
							? Effect.void
							: Effect.fail(
									new Network.NetworkError({
										reason: "BlockedTarget",
										message: "IP literal is a forbidden connection address",
									}),
								),
					),
					Match.orElse(() => Effect.void),
				)
				return normalized
			})
			const execute = Effect.fn("Node.execute")(function* (
				initial: HttpClientRequest.HttpClientRequest,
				followRedirects: boolean = true,
			) {
				const follow = (
					request: HttpClientRequest.HttpClientRequest,
					hop: number,
				): Effect.Effect<
					Network.Reply,
					Network.NetworkError | Schema.SchemaError,
					Scope.Scope
				> =>
					Effect.gen(function* () {
						const url = yield* check(request.url)
						const hopScope = yield* Scope.make()
						yield* Effect.addFinalizer((exit) => Scope.close(hopScope, exit))
						const response = yield* http
							.execute(
								HttpClientRequest.setHeader(
									HttpClientRequest.setUrl(request, url),
									"host",
									new URL(url).host,
								),
							)
							.pipe(
								Scope.provide(hopScope),
								Effect.mapError((e) =>
									e.reason.cause instanceof Network.NetworkError
										? e.reason.cause
										: new Network.NetworkError({
												reason: "Transport",
												message: e.reason._tag,
											}),
								),
							)
						const location = response.headers["location"]
						if (
							followRedirects &&
							[301, 302, 303, 307, 308].includes(response.status) &&
							location !== undefined
						) {
							yield* Scope.close(hopScope, Exit.void)
							if (hop >= maxRedirects)
								return yield* new Network.NetworkError({
									reason: "Redirect",
									message: "Redirect limit exceeded",
								})
							const target = yield* Effect.try({
								try: () => new URL(location, url).href,
								catch: () =>
									new Network.NetworkError({
										reason: "Redirect",
										message: "Invalid redirect target",
									}),
							})
							const checked = yield* check(target)
							if (
								request.method !== "GET" &&
								request.method !== "HEAD" &&
								([301, 302, 303].includes(response.status) ||
									new URL(checked).origin !== new URL(url).origin)
							) {
								return yield* new Network.NetworkError({
									reason: "Redirect",
									message:
										"Redirect would change a business request target or method",
								})
							}
							const headers =
								new URL(checked).origin === new URL(url).origin
									? request.headers
									: Object.fromEntries(
											Object.entries(request.headers).filter(([name]) =>
												["accept", "accept-encoding", "user-agent"].includes(
													name.toLowerCase(),
												),
											),
										)
							let next = HttpClientRequest.setHeaders(
								HttpClientRequest.setUrl(request, checked),
								headers,
							)
							// setHeaders merges headers, so build a clean request for a cross-origin GET.
							if (new URL(checked).origin !== new URL(url).origin)
								next = HttpClientRequest.make(request.method)(checked, {
									headers,
								})
							return yield* follow(next, hop + 1)
						}
						let body = response.stream.pipe(
							Stream.mapError(
								(e) =>
									new Network.NetworkError({
										reason: "Transport",
										message: e.reason._tag,
									}),
							),
						)
						const encoding = response.headers["content-encoding"]
							?.toLowerCase()
							.trim()
						if (encoding !== undefined && encoding !== "identity") {
							if (!["gzip", "deflate", "br"].includes(encoding))
								return yield* new Network.NetworkError({
									reason: "Encoding",
									message: "Unsupported content encoding",
								})
							body = body.pipe(
								NodeStream.pipeThroughDuplex({
									evaluate: () =>
										encoding === "gzip"
											? createGunzip()
											: encoding === "br"
												? createBrotliDecompress()
												: createInflate(),
									onError: () =>
										new Network.NetworkError({
											reason: "Encoding",
											message: "Could not decode the HTTP body",
										}),
								}),
							)
						}
						return {
							url,
							status: response.status,
							headers: response.headers,
							body,
						} satisfies Network.Reply
					})
				return yield* follow(initial, 0)
			})
			const readDocument = Effect.fn("Node.readDocument")(
				function* (input: {
					readonly url: string
					readonly headers?: Readonly<Record<string, string>>
					readonly followRedirects?: boolean
				}) {
					const reply = yield* execute(
						HttpClientRequest.get(input.url, {
							headers: {
								"accept-encoding": "gzip, deflate, br",
								...input.headers,
							},
						}),
						input.followRedirects,
					)
					const text = yield* HttpNetwork.readBounded({
						reply,
						maxBytes,
					})
					return {
						url: reply.url,
						status: reply.status,
						headers: reply.headers,
						text,
					}
				},
				Effect.scoped,
				Effect.timeoutOrElse({
					duration: timeoutMs,
					orElse: () =>
						Effect.fail(
							new Network.NetworkError({
								reason: "Timeout",
								message: "Document fetch timed out",
							}),
						),
				}),
			)
			return Network.Network.of({
				identity: guard.identity,
				execute,
				readDocument,
			})
		}),
	).pipe(Layer.provide(layerClient))
}

export const layerUserNetwork = (options: UserOptions) =>
	layerNetwork(options, {
		identity: { scope: "user", owner: options.owner },
		allowAddress: options.allowAddress,
		allowedOrigins: Option.some(options.allowedOrigins),
	})
export const layerPublicNetwork = (options: PublicOptions = {}) => {
	const network = layerNetwork(options, {
		identity: { scope: "public", owner: "anonymous" },
		allowAddress: isPublicAddress,
		allowedOrigins: Option.none(),
	})
	const anonymous = Layer.effect(
		Network.PublicNetwork,
		Effect.gen(function* () {
			const net = yield* Network.Network
			return Network.PublicNetwork.of({
				readDocument: (input) =>
					net.readDocument({
						url: input.url,
						headers: {
							"user-agent": `${Network.publicProductToken}/0.1 public catalog crawler`,
							accept: `${Document.cardMediaType}, ${Document.catalogMediaType}, text/html, text/plain`,
							...RecordUtils.filter(
								{
									"if-none-match": input.validators?.etag,
									"if-modified-since": input.validators?.lastModified,
								},
								Predicate.isNotUndefined,
							),
						},
						...RecordUtils.filter(
							{ followRedirects: input.followRedirects },
							Predicate.isNotUndefined,
						),
					}),
			})
		}),
	)
	return anonymous.pipe(Layer.provideMerge(network))
}
