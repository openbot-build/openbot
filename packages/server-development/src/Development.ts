import {
	type FileStorageInput,
	StorageEndpoint,
	BucketName,
	PublicOrigin,
} from "@openbot-build/domain/Settings"
import { NodeCrypto, NodeServices } from "@effect/platform-node"

import { CatalogDiscovery, Discovery } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Config,
	Context,
	Deferred,
	Effect,
	HashSet,
	Layer,
	Option,
	Redacted,
	Result,
	Schedule,
	String as Str,
	pipe,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import type { Configuration as AuthConfiguration } from "@openbot-build/server-kernel/AuthModel"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no HMAC API, so the development secret uses node:crypto.
import { createHmac } from "node:crypto"
import { Host, type Launch } from "@openbot-build/openbot"
import { IndexWork } from "@openbot-build/apps-contract/apps/IndexWork"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
import { BuiltinModels } from "@openbot-build/models-contract/BuiltinModels"
import * as DevelopmentModel from "./DevelopmentModel.ts"
import * as DevelopmentApps from "./DevelopmentApps.ts"
import * as DevelopmentAuthorization from "./DevelopmentAuthorization.ts"
import * as DevelopmentScenarios from "./DevelopmentScenarios.ts"
import * as DevelopmentBusiness from "./DevelopmentBusiness.ts"
import * as DevelopmentProofs from "./DevelopmentProofs.ts"
import * as EnvironmentConfiguration from "@openbot-build/server-kernel/EnvironmentConfiguration"
import * as S3 from "@openbot-build/plugin-files/S3"
import * as OutboundGuard from "@openbot-build/server-kernel/OutboundGuard"
import * as OutboundPolicy from "@openbot-build/server-kernel/OutboundPolicy"
import * as ErrorReporting from "@openbot-build/server-kernel/Reporting"
import * as Background from "@openbot-build/server-kernel/Background"

const cardUrl = "https://app.development.test/card.json"
const catalogUrl = "https://app.development.test/.well-known/ai-catalog.json"

const candidate = (
	input: string,
	mode: DevelopmentScenarios.Mode,
): Effect.Effect<Discovery.Candidate, Discovery.Error> =>
	Effect.gen(function* () {
		const url = yield* CatalogDiscovery.inputLink(input)
		if (url !== catalogUrl && url !== cardUrl)
			return yield* Discovery.DiscoveryError.make({
				reason: "NoDeclaration",
				issues: [
					{ url, reason: "No simulated App is configured for this address" },
				],
			})
		const card = DevelopmentApps.cardFor(mode)
		const remote = card.remotes[0]
		return yield* Discovery.Candidate.decode({
			cardUrl,
			card,
			endpoints: Arr.map(card.remotes, (remote, index) => ({
				index,
				remote,
				requirements: CatalogDiscovery.requirements(remote),
			})),
			sources: [
				{ role: "input", url, originalInput: input },
				{ role: "catalog", url: catalogUrl },
				{ role: "card", url: cardUrl },
				{ role: "endpoint", url: remote.url },
			],
		})
	})

/** Fixed protocol-shaped discovery with no network adapter or fallback. */
const layerDiscovery = Layer.effect(
	Discovery.Discovery,
	Effect.map(DevelopmentScenarios.Scenarios, (scenarios) => {
		const selected = (input: string) =>
			Effect.flatMap(scenarios.mode, (mode) => candidate(input, mode))
		return Discovery.Discovery.of({
			resolve: (input) =>
				selected(input).pipe(
					Effect.map((candidate) => ({
						_tag: "Single",
						candidate,
						issues: [],
					})),
				),
			refreshCard: selected,
			refresh: (previous) =>
				selected(previous.cardUrl).pipe(
					Effect.map((current) =>
						CatalogDiscovery.compare({ previous, current }),
					),
				),
		})
	}),
)

/**
 * The services from outside of OpenBot on a development platform that take
 * the place of the real ones. The discovery, the network and the check of
 * Apps, the public network of the App Index and the DNS check of domains are
 * simulated. The other services from outside are the real ones.
 */
const layerOutside = Layer.mergeAll(
	layerDiscovery,
	DevelopmentApps.layerNetwork,
	DevelopmentApps.layerProbe,
	DevelopmentApps.layerPublicNetwork,
	DevelopmentProofs.layerDomainControl,
)

/**
 * The sign-in secret of the development entry. It comes from the first
 * secret key, so it stays the same across restarts without its own setting.
 */
export const developmentSecret = (secretKeys: Redacted.Redacted<string>) =>
	Redacted.make(
		createHmac(
			"sha256",
			pipe(Redacted.value(secretKeys), Str.split(","), Arr.headNonEmpty),
		)
			.update("openbot-development-auth")
			.digest("hex"),
	)

/** The settings of the development server. */
export interface Settings extends Omit<Launch.Settings, "outboundAllow"> {
	readonly auth: AuthConfiguration
	/** The local object storage for files, such as RustFS from devenv. */
	readonly fileStorage?: FileStorageInput | undefined
	/** The entries of the loader, such as the preset with the probes of a test. */
	readonly entries?: Host.AppOptions["entries"]
	/** More plugins that the entries can name, such as the probes of a test. */
	readonly plugins?: Host.AppOptions["plugins"]
}

/**
 * The development server: `Host.layer` with simulated discovery and models,
 * and the normal configured identity and storage. It gives the services of
 * the kernel and the state of the simulated App (`Scenarios`, `Business`,
 * `Publication`, `Proofs`). It needs the platform services, such as
 * `NodeServices.layer`, `NodeCrypto.layer` and `FetchHttpClient.layer`. The
 * entry point sets the outbound guard, because it changes the whole process.
 */
export const layer = (settings: Settings) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const { builtinModels } = yield* DevelopmentModel.make
			const proofs = yield* DevelopmentProofs.Proofs
			// The simulated App reads the address of OpenBot from the platform
			// settings, so the host builds it with its services from outside.
			// Its routes use the same one.
			const authorization =
				yield* Deferred.make<
					DevelopmentAuthorization.Authorization["Service"]
				>()
			const layerAuthorization = DevelopmentAuthorization.layer.pipe(
				Layer.tap((context) =>
					Deferred.succeed(
						authorization,
						Context.get(context, DevelopmentAuthorization.Authorization),
					),
				),
			)
			return Host.layer({
				...settings,
				hostTools: DevelopmentModel.layerHostTools,
				outside: Layer.mergeAll(
					layerOutside,
					Layer.succeed(BuiltinModels, builtinModels),
				).pipe(Layer.provide(layerAuthorization)),
				work: [
					Host.routes({
						name: "development-authorization",
						inject: [],
						layer: Layer.unwrap(
							Effect.map(Deferred.await(authorization), (service) =>
								DevelopmentAuthorization.layerRoutes.pipe(
									Layer.provide(
										Layer.succeed(
											DevelopmentAuthorization.Authorization,
											service,
										),
									),
								),
							),
						),
					}),
					Host.routes({
						name: "development-proofs",
						inject: [Auth],
						layer: DevelopmentProofs.layerRoutes.pipe(
							Layer.provide(Layer.succeed(DevelopmentProofs.Proofs, proofs)),
						),
					}),
					// Index the simulated App in the background, so the server listens at once.
					Host.startup({
						name: "development-app",
						inject: [IndexWork],
						layer: Layer.effectDiscard(
							Effect.gen(function* () {
								const work = yield* IndexWork
								const background = yield* Background.make
								yield* work
									.request(cardUrl, [])
									.pipe(
										background.logFailure(
											"The development App was not indexed",
										),
										Effect.forkScoped,
									)
							}),
						),
					}),
				],
			})
		}),
	).pipe(
		Layer.provideMerge(DevelopmentProofs.layer),
		Layer.provideMerge(DevelopmentApps.layerPublication),
		Layer.provideMerge(DevelopmentScenarios.layer),
		Layer.provideMerge(DevelopmentBusiness.layer),
	)

/** The local object storage. Its secret key is always set. */
type Storage = FileStorageInput & {
	readonly secretAccessKey: Redacted.Redacted<string>
}

/** The local RustFS that devenv starts. Without it, development has no file storage. */
const fileStorage = Config.all({
	endpoint: Config.schema(StorageEndpoint, "OPENBOT_DEV_S3_ENDPOINT"),
	bucket: Config.schema(BucketName, "OPENBOT_DEV_S3_BUCKET"),
	accessKeyId: Config.String("OPENBOT_DEV_S3_ACCESS_KEY_ID"),
	secretAccessKey: Config.Redacted("OPENBOT_DEV_S3_SECRET_ACCESS_KEY"),
}).pipe(
	Config.map((storage): Storage => ({
		...storage,
		publicEndpoint: null,
		region: "us-east-1",
		forcePathStyle: true,
	})),
	Config.option,
)

/**
 * The guard blocks private addresses, and the local RustFS is one. So the
 * development entry opens the host of the storage, and only that host.
 */
const allowStorage = (
	allow: OutboundPolicy.Allow,
	storage: Option.Option<Storage>,
): OutboundPolicy.Allow =>
	Option.match(storage, {
		onNone: () => allow,
		onSome: ({ endpoint }) =>
			Result.match(OutboundPolicy.parse(new URL(endpoint).hostname), {
				onFailure: () => allow,
				onSuccess: (extra) => ({
					hostnames: HashSet.union(allow.hostnames, extra.hostnames),
					networks: [...allow.networks, ...extra.networks],
				}),
			}),
	})

/** Makes the bucket. RustFS may still start, so it tries again for a while. */
const createBucket = (storage: Storage) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const now = yield* Clock.currentTimeMillis
		yield* S3.createBucket(client, storage, now)
	}).pipe(
		Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
		Background.beforeStorage.logFailure("The development bucket was not made"),
	)

/**
 * Runs the development server as `pnpm dev` does, until the process stops. It
 * reads the settings from the environment, and the local object storage from
 * the `OPENBOT_DEV_S3_*` variables. It gives the server the Node services and
 * the fetch HTTP client.
 */
export const launch = ErrorReporting.withStartup(
	Effect.gen(function* () {
		const settings = yield* EnvironmentConfiguration.load
		// Only the development entry reads the origin from the environment.
		// It has one instance, and it writes the platform settings itself.
		const publicOrigin = yield* Config.schema(
			PublicOrigin,
			"OPENBOT_DEV_PUBLIC_ORIGIN",
		)
		const storage = yield* fileStorage
		return yield* Layer.launch(
			Layer.effectDiscard(
				Effect.logInfo(
					`Development login: POST ${publicOrigin}/auth/development/sign-in`,
				),
			).pipe(
				Layer.provideMerge(
					layer({
						...settings,
						fileStorage: Option.getOrUndefined(storage),
						auth: {
							mode: "development",
							publicOrigin,
							secret: developmentSecret(settings.secretKeys),
						},
					}),
				),
				// The server starts at once. The bucket comes when RustFS is ready.
				Layer.provideMerge(
					Layer.effectDiscard(
						Option.match(storage, {
							onNone: () => Effect.void,
							onSome: (target) => Effect.forkScoped(createBucket(target)),
						}),
					),
				),
				Layer.provide(
					Layer.mergeAll(
						NodeServices.layer,
						NodeCrypto.layer,
						FetchHttpClient.layer,
					),
				),
				Layer.provide(
					OutboundGuard.layer(allowStorage(settings.outboundAllow, storage)),
				),
			),
		)
	}),
)
