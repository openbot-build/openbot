import { NodeServices } from "@effect/platform-node"
import { Settings as Api } from "@openbot-build/api"

import { CatalogDiscovery, Discovery } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Config,
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
import type * as Configuration from "../configuration/Configuration.ts"
import type { Configuration as AuthConfiguration } from "../auth/Model.ts"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no HMAC API, so the development secret uses node:crypto.
import { createHmac } from "node:crypto"
import * as Server from "./Server.ts"
import * as OpenBot from "./OpenBot.ts"
import * as Drivers from "../computers/Drivers.ts"
import * as VaultReaders from "../vaults/Readers.ts"
import { IndexWork } from "../apps/IndexWork.ts"
import * as DevelopmentModel from "./DevelopmentModel.ts"
import * as DevelopmentApps from "./DevelopmentApps.ts"
import * as DevelopmentAuthorization from "./DevelopmentAuthorization.ts"
import * as DevelopmentScenarios from "./DevelopmentScenarios.ts"
import * as DevelopmentBusiness from "./DevelopmentBusiness.ts"
import * as DevelopmentProofs from "./DevelopmentProofs.ts"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as S3 from "../files/S3.ts"
import * as OutboundGuard from "../network/OutboundGuard.ts"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"
import * as ErrorReporting from "../errors/Reporting.ts"
import * as Background from "../execution/Background.ts"

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
 * The services from outside of OpenBot on a development platform. The
 * discovery, the network and the check of Apps, the public network of the App
 * Index and the DNS check of domains are simulated. The Computer drivers, the
 * Live backends and the readers of password managers are real.
 */
const layerOutside = Layer.mergeAll(
	layerDiscovery,
	DevelopmentApps.layerNetwork,
	DevelopmentApps.layerProbe,
	DevelopmentApps.layerPublicNetwork,
	DevelopmentProofs.layerDomainControl,
	Drivers.layer,
	OpenBot.layerLiveBackends,
	VaultReaders.layer,
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

/**
 * Assemble simulated discovery and models with the normal configured identity and storage.
 * It needs the platform services, such as `NodeServices.layer` and
 * `FetchHttpClient.layer`. The entry point sets the outbound guard, because it
 * changes the whole process.
 */
export const layer = (
	settings: Omit<Configuration.Settings, "outboundAllow"> & {
		readonly auth: AuthConfiguration
		/** The local object storage for files, such as RustFS from devenv. */
		readonly routes?: Server.AppOptions["routes"]
		readonly fileStorage?: Api.FileStorageInput | undefined
	},
) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const { builtinModels } = yield* DevelopmentModel.make
			const authorization = yield* DevelopmentAuthorization.Authorization
			const proofs = yield* DevelopmentProofs.Proofs
			// The development entry owns its platform, so each start writes its origin again.
			return Server.layerFixed({
				...settings,
				builtinModels,
				routes: Layer.mergeAll(
					settings.routes ?? Layer.empty,
					DevelopmentAuthorization.layerRoutes,
					DevelopmentProofs.layerRoutes,
				).pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(
								DevelopmentAuthorization.Authorization,
								authorization,
							),
							Layer.succeed(DevelopmentProofs.Proofs, proofs),
						),
					),
				),
				// Index the simulated App in the background, so the server listens at once.
				startup: Layer.effectDiscard(
					Effect.gen(function* () {
						const work = yield* IndexWork
						const background = yield* Background.make
						yield* work
							.request(cardUrl, [])
							.pipe(
								background.logFailure("The development App was not indexed"),
								Effect.forkScoped,
							)
					}),
				),
				indexNamespace: "development",
			})
		}),
	).pipe(
		Layer.provide(Layer.merge(DevelopmentModel.layerHostTools, layerOutside)),
		Layer.provideMerge(DevelopmentProofs.layer),
		Layer.provideMerge(DevelopmentApps.layerPublication),
		// The simulated App reads the address of OpenBot from the platform settings.
		Layer.provideMerge(DevelopmentAuthorization.layer),
		Layer.provideMerge(DevelopmentScenarios.layer),
		Layer.provideMerge(DevelopmentBusiness.layer),
		Layer.provideMerge(OpenBot.layerShared(settings)),
	)

/** The local object storage. Its secret key is always set. */
type Storage = Api.FileStorageInput & {
	readonly secretAccessKey: Redacted.Redacted<string>
}

/** The local RustFS that devenv starts. Without it, development has no file storage. */
const fileStorage = Config.all({
	endpoint: Config.schema(Api.StorageEndpoint, "OPENBOT_DEV_S3_ENDPOINT"),
	bucket: Config.schema(Api.BucketName, "OPENBOT_DEV_S3_BUCKET"),
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
export const launchWith = (routes?: Server.AppOptions["routes"]) =>
	ErrorReporting.withStartup(
		Effect.gen(function* () {
			const settings = yield* EnvironmentConfiguration.load
			// Only the development entry reads the origin from the environment.
			// It has one instance, and it writes the platform settings itself.
			const publicOrigin = yield* Config.schema(
				Api.PublicOrigin,
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
							routes,
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
					Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
					Layer.provide(
						OutboundGuard.layer(allowStorage(settings.outboundAllow, storage)),
					),
				),
			)
		}),
	)

export const launch = launchWith()
