import * as Models from "./DeveloperModels.ts"
import { Developers } from "@openbot-build/domain"

import {
	CatalogDiscovery,
	Client,
	Discovery,
	Index,
	Indexing,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Effect,
	HashMap,
	Layer,
	Match,
	Option,
	Redacted,
	pipe,
} from "effect"
import type { PgClient } from "@effect/sql-pg"
import { discover } from "./Discovery.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as IndexStore from "./IndexStore.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../errors/Failures.ts"
import * as Report from "../errors/Report.ts"
import type { Records } from "../errors/Records.ts"

export class AppInspections extends Context.Service<
	AppInspections,
	{
		readonly inspect: (
			input: string,
		) => Effect.Effect<
			Models.InspectionReport,
			Developers.DeveloperInputInvalid
		>
	}
>()("@openbot-build/openbot/apps/AppInspections") {}

export const make: Effect.Effect<
	typeof AppInspections.Service,
	never,
	| Discovery.Discovery
	| Indexing.PublicationInspection
	| Index.IndexStore
	| PgClient.PgClient
	| Records
> = Effect.gen(function* () {
	const inspection = yield* Indexing.PublicationInspection
	const report = yield* Report.make
	const index = yield* Index.IndexStore
	const db = yield* Db.make
	const namespace = yield* IndexNamespace
	const discovery = yield* Discovery.Discovery
	return AppInspections.of({
		inspect: (input) =>
			Effect.gen(function* () {
				yield* CatalogDiscovery.inputLink(input).pipe(
					Failures.replace("The App inspection input is not valid", () =>
						Developers.DeveloperInputInvalid.make({
							message: "Enter a domain or an HTTPS link without credentials.",
						}),
					),
				)
				const checkedAt = yield* Clock.currentTimeMillis
				const found = yield* discover(input).pipe(
					Effect.provideService(Discovery.Discovery, discovery),
					Effect.tapCauseIf(Cause.hasFails, (cause) =>
						report("The App publication could not be found", cause),
					),
					Effect.result,
				)
				return yield* Match.value(found).pipe(
					Match.tagsExhaustive({
						Failure: ({ failure }) =>
							Effect.succeed<Models.InspectionReport>({
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
								issues: Arr.map(
									failure.issues.length === 0
										? [{ url: input, reason: failure.reason }]
										: failure.issues,
									(issue) => ({
										code: failure.reason,
										impacts: ["discovery", "indexing"] as const,
										stage: "publication" as const,
										severity: "blocking" as const,
										source: issue.url,
										message: issue.reason,
										repair:
											"Check the publication address and publish a valid public AI Catalog and Server Card, then inspect again.",
									}),
								),
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
												checks: IndexStore.checks(db, namespace),
											}).pipe(
												// The report says "Unknown". The sealed record keeps the reason.
												Effect.tapCauseIf(Cause.hasFails, (cause) =>
													report("Public Index state could not be read", cause),
												),
												Effect.result,
											)
											const eligibility = yield* inspection
												.inspect(
													yield* Indexing.Input.decode({
														cardUrl: candidate.cardUrl,
														sources: candidate.sources,
													}),
													Option.none(),
												)
												.pipe(
													Effect.tap((result) =>
														Option.match(Client.errorCause(result), {
															onNone: () => Effect.void,
															onSome: (cause) =>
																report(
																	"The App publication could not be checked",
																	Redacted.value(cause),
																),
														}),
													),
													Effect.tapCauseIf(Cause.hasFails, (cause) =>
														report(
															"The App publication could not be checked",
															cause,
														),
													),
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
															issue:
																"The App publication could not be checked.",
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
															check: HashMap.get(
																success.checks,
																candidate.cardUrl,
															).pipe(
																Option.orElse(() =>
																	Option.map(success.entry, (entry) => ({
																		_tag: "Indexed" as const,
																		attemptedAt: entry.checkedAt,
																	})),
																),
																Option.getOrNull,
															),
														}),
													}),
												),
											}
										}),
									{ concurrency: 4 },
								)
								const issues: ReadonlyArray<Developers.Issue> = [
									...pipe(
										apps,
										Arr.filter(
											(app) => (app.candidate.card.icons?.length ?? 0) === 0,
										),
										Arr.map((app): Developers.Issue => ({
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
									),

									...Arr.map(success.issues, (issue) => ({
										code: "InvalidCandidate",
										impacts: ["discovery", "connection", "indexing"] as const,
										stage: "card" as const,
										severity: "blocking" as const,
										source: issue.url,
										message: issue.reason,
										repair: "Repair this Card declaration and inspect again.",
									})),
									...Arr.flatMap(apps, (app): ReadonlyArray<Developers.Issue> =>
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
										...Arr.flatMap(apps, (app) => app.eligibility.stages),
									],
								}
							}),
					}),
				)
			}).pipe(
				// A Card that is not a valid indexing input is a problem of the publication.
				Failures.replaceTag(
					"IndexingError",
					"A discovered Card URL is not a valid indexing input",
					() =>
						Developers.DeveloperInputInvalid.make({
							message: "The publication input could not be checked.",
						}),
				),
			),
	})
})
export const layer = Layer.effect(AppInspections, make)
