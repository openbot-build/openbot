import { NodeCrypto } from "@effect/platform-node"
import { Settings as Api } from "@openbot-build/api"
import { CatalogDiscovery, Discovery } from "@openbot-build/protocol"
import {
	Clock,
	Config,
	Effect,
	HashSet,
	Layer,
	Option,
	Redacted,
	Result,
	Schedule,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import type * as Configuration from "../configuration/Configuration.ts"
import type { Configuration as AuthConfiguration } from "../auth/Model.ts"
import { createHmac } from "node:crypto"
import * as Server from "./Server.ts"
import { IndexNamespace } from "../apps/IndexNamespace.ts"
import * as IndexJobs from "../apps/IndexWork.ts"
import { IndexWork } from "../apps/IndexWork.ts"
import * as DevelopmentModel from "./DevelopmentModel.ts"
import * as DevelopmentApps from "./DevelopmentApps.ts"
import * as DevelopmentAuthorization from "./DevelopmentAuthorization.ts"
import * as DevelopmentScenarios from "./DevelopmentScenarios.ts"
import * as DevelopmentBusiness from "./DevelopmentBusiness.ts"
import * as DevelopmentProofs from "./DevelopmentProofs.ts"
import * as Db from "../database/Database.ts"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as S3 from "../files/S3.ts"
import * as OutboundGuard from "../network/OutboundGuard.ts"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"
import * as ErrorReporting from "./ErrorReporting.ts"

const cardUrl = "https://app.development.test/card.json"
const catalogUrl = "https://app.development.test/.well-known/ai-catalog.json"

const candidate = (
	input: string,
	mode: DevelopmentScenarios.Mode,
): Effect.Effect<Discovery.Candidate, Discovery.Error> =>
	Effect.gen(function* () {
		const url = yield* CatalogDiscovery.inputLink(input)
		if (url !== catalogUrl && url !== cardUrl)
			return yield* new Discovery.DiscoveryError({
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
			endpoints: card.remotes.map((remote, index) => ({
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
const layerDiscovery = (
	scenarios: typeof DevelopmentScenarios.Scenarios.Service,
): Layer.Layer<Discovery.Discovery> => {
	const selected = (input: string) =>
		Effect.flatMap(scenarios.mode, (mode) => candidate(input, mode))
	return Layer.succeed(Discovery.Discovery, {
		resolve: (input) =>
			selected(input).pipe(
				Effect.map((candidate) => ({ _tag: "Single", candidate, issues: [] })),
			),
		refreshCard: selected,
		refresh: (previous) =>
			selected(previous.cardUrl).pipe(
				Effect.map((current) =>
					CatalogDiscovery.compare({ previous, current }),
				),
			),
	})
}

/**
 * The sign-in secret of the development entry. It comes from the first
 * secret key, so it stays the same across restarts without its own setting.
 */
export const developmentSecret = (secretKeys: Redacted.Redacted<string>) =>
	Redacted.make(
		createHmac("sha256", Redacted.value(secretKeys).split(",")[0] ?? "")
			.update("openbot-development-auth")
			.digest("hex"),
	)

/**
 * Assemble simulated discovery and models with the normal configured identity and storage.
 * The entry point sets the outbound guard, because it changes the whole process.
 */
export const layer = (
	settings: Omit<Configuration.Settings, "outboundAllow"> & {
		readonly auth: AuthConfiguration
		/** The local object storage for files, such as RustFS from devenv. */
		readonly fileStorage?: Api.FileStorageInput | undefined
	},
) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const { chats, builtinModels } = yield* DevelopmentModel.make
			const publication = yield* DevelopmentApps.Publication
			const authorization = yield* DevelopmentAuthorization.Authorization
			const scenarios = yield* DevelopmentScenarios.Scenarios
			const business = yield* DevelopmentBusiness.Business
			const proofs = yield* DevelopmentProofs.Proofs
			const proofLayer = Layer.succeed(DevelopmentProofs.Proofs, proofs)
			const authorizationLayer = Layer.merge(
				Layer.succeed(DevelopmentBusiness.Business, business),
				Layer.succeed(DevelopmentAuthorization.Authorization, authorization),
			)
			const server = Server.layerFixed({
				...settings,
				// The development entry owns its platform, so a new port just replaces the origin.
				force: true,
				chats,
				builtinModels,
				discovery: layerDiscovery(scenarios),
				appNetwork: DevelopmentApps.layerNetwork.pipe(
					Layer.provide(authorizationLayer),
				),
				appProbe: DevelopmentApps.layerProbe.pipe(
					Layer.provide(authorizationLayer),
				),
				routes: (auth) =>
					Layer.merge(
						DevelopmentAuthorization.layerRoutes.pipe(
							Layer.provide(authorizationLayer),
						),
						DevelopmentProofs.layerRoutes(auth.publicOrigin).pipe(
							Layer.provide(proofLayer),
						),
					),
				domainControl: DevelopmentProofs.layerDomainControl.pipe(
					Layer.provide(proofLayer),
				),
				// Index the simulated App in the background, so the server listens at once.
				startup: Layer.effectDiscard(
					Effect.gen(function* () {
						const work = yield* IndexWork
						yield* IndexJobs.enqueue(
							yield* Db.make,
							yield* IndexNamespace,
							cardUrl,
							[],
						)
						yield* work.runOne(cardUrl)
					}).pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning("The development App was not indexed", cause),
						),
						Effect.forkScoped,
					),
				),
				indexNamespace: "development",
				indexPublicNetwork: DevelopmentApps.layerPublicNetwork.pipe(
					Layer.provide(
						Layer.succeed(DevelopmentScenarios.Scenarios, scenarios),
					),
					Layer.provide(proofLayer),
					Layer.provide(
						Layer.succeed(DevelopmentApps.Publication, publication),
					),
				),
			}).pipe(Layer.provide(DevelopmentModel.layerTools))
			return server
		}),
	).pipe(
		Layer.provideMerge(DevelopmentProofs.layer),
		Layer.provideMerge(DevelopmentApps.layerPublication),
		Layer.provideMerge(
			DevelopmentAuthorization.layer(settings.auth.publicOrigin),
		),
		Layer.provideMerge(DevelopmentScenarios.layer),
		Layer.provideMerge(DevelopmentBusiness.layer),
	)

/** The local RustFS that devenv starts. Without it, development has no file storage. */
const fileStorage = Config.all({
	endpoint: Config.schema(Api.StorageEndpoint, "OPENBOT_DEV_S3_ENDPOINT"),
	bucket: Config.schema(Api.BucketName, "OPENBOT_DEV_S3_BUCKET"),
	accessKeyId: Config.String("OPENBOT_DEV_S3_ACCESS_KEY_ID"),
	secretAccessKey: Config.String("OPENBOT_DEV_S3_SECRET_ACCESS_KEY"),
}).pipe(
	Config.map((storage): Api.FileStorageInput => ({
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
	storage: Api.FileStorageInput | undefined,
): OutboundPolicy.Allow =>
	storage === undefined
		? allow
		: Result.match(OutboundPolicy.parse(new URL(storage.endpoint).hostname), {
				onFailure: () => allow,
				onSuccess: (extra) => ({
					hostnames: HashSet.union(allow.hostnames, extra.hostnames),
					networks: [...allow.networks, ...extra.networks],
				}),
			})

/** Makes the bucket. RustFS may still start, so it tries again for a while. */
const createBucket = (storage: Api.FileStorageInput) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const now = yield* Clock.currentTimeMillis
		yield* S3.createBucket(
			client,
			{ ...storage, secretAccessKey: storage.secretAccessKey ?? "" },
			now,
		)
	}).pipe(
		Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
		Effect.catchCause((cause) =>
			Effect.logWarning("The development bucket was not made", cause),
		),
		// This entry point owns the bucket check, before the app starts.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(Layer.merge(FetchHttpClient.layer, NodeCrypto.layer)),
	)

/**
 * Runs the development server as `pnpm dev` does, until the process stops. It
 * reads the settings from the environment, and the local object storage from
 * the `OPENBOT_DEV_S3_*` variables.
 */
export const launch = ErrorReporting.withStartup(
	Effect.gen(function* () {
		const settings = yield* EnvironmentConfiguration.load
		// Only the development entry reads the origin from the environment.
		// It has one instance, and it writes the platform settings itself.
		const publicOrigin = yield* Config.schema(
			Api.PublicOrigin,
			"OPENBOT_DEV_PUBLIC_ORIGIN",
		)
		const storage = Option.getOrUndefined(yield* fileStorage)
		return yield* Layer.launch(
			Layer.effectDiscard(
				Effect.logInfo(
					`Development login: POST ${publicOrigin}/auth/development/sign-in`,
				),
			).pipe(
				Layer.provideMerge(
					layer({
						...settings,
						fileStorage: storage,
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
						storage === undefined
							? Effect.void
							: Effect.forkScoped(createBucket(storage)),
					),
				),
				Layer.provide(
					OutboundGuard.layer(allowStorage(settings.outboundAllow, storage)),
				),
			),
		)
	}),
)
