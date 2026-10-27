import { GrantCleanup, scopeOf } from "./GrantCleanup.ts"
import { Settings } from "../settings/Settings.ts"
import * as Platform from "../settings/Platform.ts"
import * as ClientMetadata from "./ClientMetadata.ts"
import { AppAuthorizations } from "@openbot-build/domain"
import {
	App,
	Client,
	Authorization,
	Network,
	OAuthAuthorization,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Crypto,
	Layer,
	Option,
	Redacted,
	Schema,
} from "effect"
import { Calls } from "../execution/Calls.ts"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { AppHost, AppNetwork } from "./AppHost.ts"
import {
	AuthorizationCommands,
	preparationCodec,
	type Preparation,
	workflowName,
} from "./AuthorizationCommands.ts"

export const workflow = Engine.define(workflowName)
const grantCodec = Schema.toCodecJson(OAuthAuthorization.Grant)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* AuthorizationCommands
		const cleanup = yield* GrantCleanup
		const factory = yield* AppHost
		const settings = yield* Settings
		const crypto = yield* Crypto.Crypto
		const network = yield* AppNetwork
		const active = yield* App.ConnectionScopes
		const calls = yield* Calls
		const store = yield* Store
		const registry = yield* Engine.Registry
		const run = yield* Program.make
		const withNetwork = <A, E, R>(
			owner: string,
			urls: ReadonlyArray<string>,
			work: Effect.Effect<A, E, R | Network.Network>,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(
						network.layer(
							owner,
							Arr.map(urls, (url) => new URL(url).origin),
						),
					)
					return yield* work.pipe(Effect.provideContext(context))
				}),
			)
		const work = (fence: Fence) =>
			Effect.gen(function* () {
				const { input } = yield* commands.load(fence)
				const connection = input.connection.connection
				const key = {
					owner: connection.owner,
					connectionId: connection.connectionId,
				}
				if (input._tag === "Begin") {
					const prepared = yield* calls.invoke(
						fence,
						yield* store.readAttempt(fence, "prepare", {
							connectionId: key.connectionId,
						}),
						() =>
							Effect.gen(function* () {
								const app = factory.bind(
									key.owner,
									Client.InvocationPolicy.of({
										check: (call) =>
											Effect.fail(
												Client.PermissionDenied.make({
													action: call.action,
													target: call.target,
												}),
											),
									}),
								)
								const protection = yield* app.inspectAuthorization(key)
								if (!protection.requiresAuthorization)
									return {
										result: { _tag: "AuthorizationNotRequired" },
										flow: null,
									} satisfies Preparation
								const issuers = protection.resource.authorization_servers
								const scopes = Arr.dedupe(
									input.request.scopes.length === 0
										? protection.scopes.length === 0
											? (protection.resource.scopes_supported ?? [])
											: protection.scopes
										: input.request.scopes,
								)
								if (issuers.length > 1 && input.request.issuer === undefined)
									return {
										result: {
											_tag: "IssuerSelectionRequired",
											issuers,
											scopes,
										},
										flow: null,
									} satisfies Preparation
								const issuer = input.request.issuer ?? issuers[0]
								if (!issuers.includes(issuer))
									return yield* Authorization.AuthorizationError.make({
										reason: "Metadata",
										issue: "The issuer is not listed by this resource.",
									})
								const metadata = yield* Effect.flatMap(
									Platform.publicOriginOr(settings, () =>
										AppAuthorizations.AppAuthorizationUnavailable.make({}),
									),
									ClientMetadata.metadata,
								)
								const prepared = yield* withNetwork(
									key.owner,
									[
										connection.endpoint,
										issuer,
										metadata.client_id,
										...(protection.resourceMetadataUrl === undefined
											? []
											: [protection.resourceMetadataUrl]),
									],
									OAuthAuthorization.prepare({
										connection,
										issuer,
										clientId: metadata.client_id,
										redirectUri: metadata.redirect_uris[0],
										scopes,
										...(protection.resourceMetadataUrl === undefined
											? {}
											: {
													resourceMetadataUrl: protection.resourceMetadataUrl,
												}),
									}).pipe(Effect.provideService(Crypto.Crypto, crypto)),
								)
								return {
									result: {
										_tag: "AuthorizationStarted",
										flowId: prepared.flow.flowId,
										authorizationUrl: prepared.pending.authorizationUrl,
										issuer: prepared.pending.issuer,
										scopes: prepared.pending.scopes,
									},
									flow: prepared.flow,
								} satisfies Preparation
							}).pipe(
								Effect.timeout("30 seconds"),
								Effect.flatMap(Schema.encodeEffect(preparationCodec)),
							),
					)
					if (prepared._tag === "Unknown") return
					yield* commands.commitPrepared(
						fence,
						yield* Schema.decodeEffect(preparationCodec)(prepared.result),
					)
					return
				}
				if (input._tag !== "Refresh") yield* active.close(key)
				if (input._tag === "Revoke" || input._tag === "Remove") {
					yield* commands.commit(fence, null)
					return
				}
				if (input._tag === "Complete") {
					const result = yield* calls.invoke(
						fence,
						{
							...(yield* cleanup.writeAttempt(
								fence,
								"exchange",
								{
									flowId: input.flow.flowId,
								},
								{
									issuer: input.flow.binding.issuer,
									clientId: input.flow.clientId,
								},
							)),
							onResult: (callId) =>
								cleanup
									.enqueue(fence, callId, input.flow.metadata)
									.pipe(Effect.asVoid),
						},
						() =>
							withNetwork(
								key.owner,
								[
									input.flow.metadata.issuer,
									input.flow.metadata.token_endpoint,
								],
								OAuthAuthorization.redeem({
									connection,
									flow: input.flow,
									callbackUrl: Redacted.value(input.callback),
								}),
							).pipe(
								Effect.timeout("30 seconds"),
								Effect.flatMap(Schema.encodeEffect(grantCodec)),
							),
						OAuthAuthorization.validateCallback(
							connection,
							input.flow,
							Redacted.value(input.callback),
						).pipe(Effect.asVoid),
					)
					if (result._tag === "Unknown") return
					yield* commands.commit(fence, {
						callId: result.callId,
						grant: yield* Schema.decodeEffect(grantCodec)(result.result),
					})
				} else {
					const credential = input.credential
					if (credential !== null) {
						const auth = connection.authorization
						const resourceMetadataUrl =
							auth._tag === "Authorized" ? auth.resourceMetadataUrl : undefined
						const metadataInput = {
							issuer: credential.binding.issuer,
							resource: credential.binding.resource,
						}
						const previous = Arr.findLast(
							yield* store.calls(fence),
							(saved) =>
								saved.step === "metadata" && saved.status === "completed",
						)
						const metadata = Option.isSome(previous)
							? { _tag: "Completed" as const, result: previous.value.result }
							: yield* calls.invoke(
									fence,
									yield* store.readAttempt(fence, "metadata", metadataInput),
									() =>
										withNetwork(
											key.owner,
											[
												credential.binding.issuer,
												credential.binding.resource,
												...(resourceMetadataUrl === undefined
													? []
													: [resourceMetadataUrl]),
											],
											OAuthAuthorization.discover({
												...metadataInput,
												...(resourceMetadataUrl === undefined
													? {}
													: { resourceMetadataUrl }),
											}),
										).pipe(
											Effect.map(({ metadata }) => metadata),
											Effect.flatMap(
												Schema.encodeEffect(
													Schema.toCodecJson(Authorization.ServerMetadata),
												),
											),
										),
								)
						if (metadata._tag === "Unknown") return
						const saved = yield* Schema.decodeEffect(
							Schema.toCodecJson(Authorization.ServerMetadata),
						)(metadata.result)
						if (input._tag === "Refresh") {
							const result = yield* calls.invoke(
								fence,
								{
									...(yield* cleanup.writeAttempt(
										fence,
										"refresh",
										{
											connectionId: key.connectionId,
										},
										scopeOf(credential),
									)),
									onResult: (callId) =>
										cleanup.enqueue(fence, callId, saved).pipe(Effect.asVoid),
								},
								() =>
									withNetwork(
										key.owner,
										[saved.issuer, saved.token_endpoint],
										OAuthAuthorization.renew({
											connection,
											credential,
											metadata: saved,
											...(resourceMetadataUrl === undefined
												? {}
												: { resourceMetadataUrl }),
										}),
									).pipe(
										Effect.timeout("30 seconds"),
										Effect.flatMap(Schema.encodeEffect(grantCodec)),
									),
							)
							if (result._tag === "Unknown") return
							const grant = yield* Schema.decodeEffect(grantCodec)(
								result.result,
							)
							if (
								grant.credential.scopes.length !== credential.scopes.length ||
								Arr.some(
									grant.credential.scopes,
									(scope) => !credential.scopes.includes(scope),
								)
							)
								yield* active.close(key)
							yield* commands.commit(fence, { callId: result.callId, grant })
							return
						}
					}
				}
			})
		return workflow
			.toLayer((key) => run(key, work, commands.finish))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, commands.authorize)),
				),
			)
	}),
)
