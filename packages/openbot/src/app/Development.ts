import { CatalogDiscovery, Discovery } from "@openbot-build/protocol"
import { Effect, Layer, Redacted } from "effect"
import type * as Configuration from "../configuration/Configuration.ts"
import type { Configuration as AuthConfiguration } from "../auth/Model.ts"
import { createHmac } from "node:crypto"
import * as Server from "./Server.ts"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { IndexNamespace } from "../apps/IndexNamespace.ts"
import * as IndexJobs from "../apps/IndexWork.ts"
import { IndexWork } from "../apps/IndexWork.ts"
import * as DevelopmentModel from "./DevelopmentModel.ts"
import * as DevelopmentApps from "./DevelopmentApps.ts"
import * as DevelopmentAuthorization from "./DevelopmentAuthorization.ts"
import * as DevelopmentScenarios from "./DevelopmentScenarios.ts"
import * as DevelopmentBusiness from "./DevelopmentBusiness.ts"
import * as DevelopmentProofs from "./DevelopmentProofs.ts"

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

/** Assemble simulated discovery and models with the normal configured identity and storage. */
export const layer = (
	settings: Configuration.Settings & { readonly auth: AuthConfiguration },
) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const { sessions, builtinModels } = yield* DevelopmentModel.make
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
				sessions,
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
							yield* makeWithDefaults(),
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
