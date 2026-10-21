import { AppIndexApi } from "@openbot-build/api"
import { Index, Indexing } from "@openbot-build/protocol"
import { Clock, Context, Effect, Layer, Match, Option, Schedule } from "effect"
import { IndexWorkRepository, type Claim } from "./IndexWorkRepository.ts"
import { Governance } from "./Governance.ts"

export interface Options {
	readonly intervalMs?: number
	readonly retryMs?: number
}
/** Fill in the default wait times once, when the Layer is built. */
const settings = (options: Options) => ({
	intervalMs: options.intervalMs ?? 3600000,
	retryMs: options.retryMs ?? 60000,
})
export class IndexWork extends Context.Service<
	IndexWork,
	{
		readonly runOne: (
			cardUrl?: string,
		) => Effect.Effect<boolean, Index.IndexError>
	}
>()("@openbot-build/openbot/apps/IndexWork") {}

export const layer = (options: Options = {}) =>
	Layer.effect(
		IndexWork,
		Effect.gen(function* () {
			const repository = yield* IndexWorkRepository
			const indexing = yield* Indexing.Indexing
			const governance = yield* Governance
			const { intervalMs, retryMs } = settings(options)
			const verify = (claim: Claim) =>
				Effect.gen(function* () {
					const outcome = yield* Option.match(governance.find(claim.cardUrl), {
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
					}).pipe(Effect.result)
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
						Match.tag("Failed", "Unconfirmed", () => retryMs),
						Match.orElse(() => intervalMs),
					)
					yield* repository.finish(claim, check, attemptedAt + delay)
					return true
				}).pipe(
					Effect.onError(() =>
						// Releasing the claim is best effort. The lease ends by itself if this fails.
						repository.release(claim).pipe(
							Effect.catch((error) =>
								Effect.logWarning("Public Index claim release failed", {
									source: "apps",
									operation: "index-release",
									reason: error.reason,
								}),
							),
						),
					),
				)
			return IndexWork.of({
				runOne: Effect.fn("IndexWork.runOne")(function* (cardUrl) {
					return yield* Option.match(yield* repository.claim(cardUrl), {
						onNone: () => Effect.succeed(false),
						onSome: verify,
					})
				}),
			})
		}),
	)

/** Each OpenBot process runs one scoped worker. It recovers saved claims at startup. */
export const layerWorker = (options: Options = {}) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const repository = yield* IndexWorkRepository
			const work = yield* IndexWork
			const { retryMs } = settings(options)
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
				Effect.repeat(Schedule.spaced(retryMs)),
				Effect.forkScoped,
			)
		}),
	)
