import { DeveloperApi as Api } from "@openbot-build/platform-api"
import { CatalogDiscovery, Discovery, Indexing } from "@openbot-build/protocol"
import { Clock, Context, Effect, HashMap, Layer, Match, Option } from "effect"
import { IndexRepository } from "./IndexRepository.ts"
import { discover } from "./Discovery.ts"

export class AppInspections extends Context.Service<
	AppInspections,
	{
		readonly inspect: (
			input: string,
		) => Effect.Effect<Api.InspectionReport, Api.DeveloperInputInvalid>
	}
>()("@openbot-build/platform/apps/AppInspections") {}

export const make: Effect.Effect<
	typeof AppInspections.Service,
	never,
	Discovery.Discovery | Indexing.PublicationInspection | IndexRepository
> = Effect.gen(function* () {
	const inspection = yield* Indexing.PublicationInspection
	const index = yield* IndexRepository
	const discovery = yield* Discovery.Discovery
	return AppInspections.of({
		inspect: (input) =>
			Effect.gen(function* () {
				yield* CatalogDiscovery.inputLink(input).pipe(
					Effect.mapError(() =>
						Api.DeveloperInputInvalid.make({
							message: "Enter a domain or an HTTPS link without credentials.",
						}),
					),
				)
				const checkedAt = yield* Clock.currentTimeMillis
				const found = yield* discover(input).pipe(
					Effect.provideService(Discovery.Discovery, discovery),
					Effect.result,
				)
				return yield* Match.value(found).pipe(
					Match.tagsExhaustive({
						Failure: ({ failure }) =>
							Effect.succeed<Api.InspectionReport>({
								input,
								checkedAt,
								apps: [],
								stages: [
									{ name: "Input", source: input, status: "Passed", checkedAt },
									{
										name: "Discovery",
										source: input,
										status: "Failed",
										checkedAt,
										reason: failure.reason,
									},
									{ name: "Eligibility", source: input, status: "NotChecked" },
								],
								issues: (failure.issues.length === 0
									? [{ url: input, reason: failure.reason }]
									: failure.issues
								).map((issue) => ({
									code: failure.reason,
									impacts: ["discovery", "indexing"] as const,
									stage: "publication" as const,
									severity: "blocking" as const,
									source: issue.url,
									message: issue.reason,
									repair:
										"Check the publication address and publish a valid public AI Catalog and Server Card, then inspect again.",
								})),
							}),
						Success: ({ success }) =>
							Effect.gen(function* () {
								const candidates = Match.value(success).pipe(
									Match.tagsExhaustive({
										Single: (result) => [result.candidate],
										Multiple: (result) => result.candidates,
									}),
								)
								const apps = yield* Effect.forEach(
									candidates,
									(candidate) =>
										Effect.gen(function* () {
											const stored = yield* Effect.all({
												entry: index.get(candidate.cardUrl),
												checks: index.checks,
											}).pipe(Effect.result)
											const eligibility = yield* inspection
												.inspect(
													yield* Indexing.Input.decode({
														cardUrl: candidate.cardUrl,
														sources: candidate.sources,
													}),
													Option.none(),
												)
												.pipe(
													Effect.catchTag("IndexingError", (error) =>
														Effect.succeed<Indexing.InspectionResult>({
															_tag: "Unconfirmed",
															stages: [
																{
																	name: "CardRead",
																	source: candidate.cardUrl,
																	status: "Unconfirmed",
																	checkedAt,
																	reason: error.reason,
																},
															],
															cardUrl: candidate.cardUrl,
															reason: error.reason,
															url: error.url,
															issue: error.issue,
														}),
													),
												)
											return {
												candidate,
												eligibility,
												stored: Match.value(stored).pipe(
													Match.tagsExhaustive({
														Failure: () => ({ _tag: "Unknown" as const }),
														Success: ({ success }) => ({
															_tag: "Known" as const,
															check:
																Option.getOrNull(
																	HashMap.get(
																		success.checks,
																		candidate.cardUrl,
																	),
																) ??
																(Option.isSome(success.entry)
																	? {
																			_tag: "Indexed" as const,
																			attemptedAt:
																				success.entry.value.checkedAt,
																		}
																	: null),
														}),
													}),
												),
											}
										}),
									{ concurrency: 4 },
								)
								const issues: ReadonlyArray<Api.Issue> = [
									...apps
										.filter(
											(app) => (app.candidate.card.icons?.length ?? 0) === 0,
										)
										.map((app): Api.Issue => ({
											code: "MissingIcon",
											fieldPath: "icons",
											impacts: ["discovery"],
											stage: "card",
											severity: "suggestion",
											source: app.candidate.cardUrl,
											message: "No App icon is declared.",
											repair:
												"Add an optional public icon to make the App easy to recognize.",
										})),

									...success.issues.map((issue) => ({
										code: "InvalidCandidate",
										impacts: ["discovery", "connection", "indexing"] as const,
										stage: "card" as const,
										severity: "blocking" as const,
										source: issue.url,
										message: issue.reason,
										repair: "Repair this Card declaration and inspect again.",
									})),
									...apps.flatMap<Api.Issue>((app) =>
										Match.value(app.eligibility).pipe(
											Match.tagsExhaustive({
												Eligible: () => [],
												Excluded: (result) => [
													{
														code: result.reason,
														impacts: ["indexing"] as const,
														stage: "indexing" as const,
														severity: "blocking" as const,
														source: app.candidate.cardUrl,
														message: result.reason,
														repair:
															"Check the publisher Catalog, robots rules and noindex declaration, then inspect again.",
													},
												],
												Unconfirmed: (result) => [
													{
														code: result.reason,
														impacts: ["indexing"] as const,
														stage: "indexing" as const,
														severity: "blocking" as const,
														source: result.url,
														message: result.issue,
														repair:
															"Restore anonymous access to the affected publication and inspect again.",
													},
												],
											}),
										),
									),
								]
								return {
									input,
									checkedAt,
									apps,
									issues,
									stages: [
										{
											name: "Input" as const,
											source: input,
											status: "Passed" as const,
											checkedAt,
										},
										{
											name: "Discovery" as const,
											source: input,
											status: "Passed" as const,
											checkedAt,
										},
										...apps.flatMap((app) => app.eligibility.stages),
									],
								}
							}),
					}),
				)
			}).pipe(
				Effect.mapError(() =>
					Api.DeveloperInputInvalid.make({
						message: "The publication input could not be checked.",
					}),
				),
			),
	})
})
export const layer = Layer.effect(AppInspections, make)
