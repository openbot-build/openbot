import { AppIndexApi } from "@openbot-build/platform-api"
import { Index, Indexing } from "@openbot-build/protocol"
import { Clock, Context, Effect, Layer, Match, Schedule } from "effect"
import { IndexWorkRepository } from "./IndexWorkRepository.ts"
import { Governance } from "./Governance.ts"
import { Option } from "effect"

export interface Options {
	readonly intervalMs?: number
	readonly retryMs?: number
}
export class IndexWork extends Context.Service<
	IndexWork,
	{
		readonly runOne: (
			cardUrl?: string,
		) => Effect.Effect<boolean, Index.IndexError>
	}
>()("@openbot-build/platform/apps/IndexWork") {}

export const layer = (options: Options = {}) =>
	Layer.effect(
		IndexWork,
		Effect.gen(function* () {
			const repository = yield* IndexWorkRepository
			const indexing = yield* Indexing.Indexing
			const governance = yield* Governance
			return IndexWork.of({
				runOne: Effect.fn("IndexWork.runOne")(function* (cardUrl) {
					const claim = yield* repository.claim(cardUrl)
					if (claim === null) return false
					return yield* Effect.gen(function* () {
						const outcome = yield* Option.match(
							governance.find(claim.cardUrl),
							{
								onNone: () =>
									indexing.sync({
										cardUrl: claim.cardUrl,
										sources: claim.sources,
									}),
								onSome: (restriction) =>
									Effect.succeed<Indexing.SyncResult>({
										_tag: "Excluded",
										cardUrl: claim.cardUrl,
										reason: restriction.reason,
									}),
							},
						).pipe(Effect.result)
						const attemptedAt = yield* Clock.currentTimeMillis
						const check: AppIndexApi.Check = Match.value(outcome).pipe(
							Match.tag(
								"Failure",
								() =>
									({
										_tag: "Failed",
										attemptedAt,
										reason: "Public verification could not complete.",
									}) as const,
							),
							Match.tag("Success", ({ success }) =>
								Match.value(success).pipe(
									Match.tagsExhaustive({
										Indexed: () => ({ _tag: "Indexed", attemptedAt }) as const,
										Excluded: ({ reason }) =>
											({ _tag: "Excluded", attemptedAt, reason }) as const,
										Withdrawn: ({ reason }) =>
											({ _tag: "Withdrawn", attemptedAt, reason }) as const,
										Unconfirmed: ({ reason }) =>
											({ _tag: "Unconfirmed", attemptedAt, reason }) as const,
									}),
								),
							),
							Match.exhaustive,
						)
						const delay = Match.value(check).pipe(
							Match.tag("Failed", () => options.retryMs ?? 60000),
							Match.tag("Unconfirmed", () => options.retryMs ?? 60000),
							Match.orElse(() => options.intervalMs ?? 3600000),
						)
						yield* repository.finish(claim, check, attemptedAt + delay)
						return true
					}).pipe(
						Effect.onError(() => repository.release(claim).pipe(Effect.ignore)),
					)
				}),
			})
		}),
	)

/** Each Platform process runs one scoped worker. It recovers saved claims at startup. */
export const layerWorker = (options: Options = {}) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const repository = yield* IndexWorkRepository
			const work = yield* IndexWork
			yield* repository.restart
			const drain: Effect.Effect<void, Index.IndexError> = Effect.suspend(() =>
				work
					.runOne()
					.pipe(
						Effect.flatMap((processed) => (processed ? drain : Effect.void)),
					),
			)
			yield* drain.pipe(
				Effect.catch(() =>
					Effect.logError("Public Index verification failed", {
						source: "apps",
						operation: "index-sync",
					}),
				),
				Effect.repeat(Schedule.spaced(options.retryMs ?? 60000)),
				Effect.forkScoped,
			)
		}),
	)
