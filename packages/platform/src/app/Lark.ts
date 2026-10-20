import { createHmac, randomUUID } from "node:crypto"
import {
	Cause,
	Clock,
	Data,
	Effect,
	Fiber,
	HashMap,
	Logger,
	Option,
	Predicate,
	Queue,
	Redacted,
	References,
	Schema,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { Settings } from "../configuration/LarkConfiguration.ts"

export type { Settings } from "../configuration/LarkConfiguration.ts"

/** Capacity and timing controls also let host-level checks give the same result every time. */
export interface Options extends Settings {
	readonly capacity?: number
	readonly aggregationCapacity?: number
	readonly windowMs?: number
	readonly intervalMs?: number
	readonly requestTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
}

interface Event {
	readonly id: string
	readonly time: string
	readonly level: string
	readonly source: string
	readonly operation: string
	readonly errorType: string
	readonly location: string
	readonly correlation: ReadonlyArray<string>
}
interface Notification {
	readonly event: Event
	readonly repeats: number
}
interface Aggregate {
	readonly event: Event
	readonly expires: number
	readonly repeats: number
}
class DeliveryError extends Data.TaggedError("LarkDeliveryError")<{
	readonly retryable: boolean
	readonly reason: string
}> {}

const Result = Schema.Struct({ code: Schema.Int })
const decodeResult = Schema.decodeUnknownEffect(Result)
const identifier = (value: unknown, fallback: string): string =>
	typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value)
		? value
		: fallback

const eventFrom = (options: Logger.Options<unknown>): Event | undefined => {
	const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
	if (
		annotations["lark.exclude"] === true ||
		(options.logLevel !== "Error" && options.logLevel !== "Fatal") ||
		Cause.hasInterruptsOnly(options.cause)
	)
		return undefined
	const error = Cause.squash(options.cause)
	const errorType = identifier(
		annotations["errorType"],
		identifier(
			Predicate.hasProperty(error, "_tag") ? error._tag : undefined,
			error instanceof Error ? identifier(error.name, "Error") : "UnknownError",
		),
	)
	// Keep only a filename and line/column. Never keep the error message or URL.
	const location =
		error instanceof Error
			? (error.stack
					?.split("\n")
					.slice(1)
					.map((line) =>
						/\b([A-Za-z0-9_.-]+\.[cm]?[jt]s):([0-9]+):([0-9]+)\)?$/.exec(
							line.trim(),
						),
					)
					.find(Predicate.isNotNull)
					?.slice(1)
					.join(":")
					.slice(-160) ?? "unknown")
			: "unknown"
	return {
		id: randomUUID(),
		time: options.date.toISOString(),
		level: options.logLevel,
		source: identifier(annotations["source"], "platform"),
		operation: identifier(annotations["operation"], "unknown"),
		errorType,
		location,
		correlation: [
			"requestId",
			"sessionId",
			"turnId",
			"method",
			"route",
			"status",
		].flatMap((key) => {
			const value = annotations[key]
			if (key === "route")
				return typeof value === "string" &&
					/^\/[A-Za-z0-9_/:.*-]{0,150}$/.test(value)
					? [`route: ${value}`]
					: []
			const safe = identifier(
				typeof value === "number" ? String(value) : value,
				"",
			)
			return safe === "" ? [] : [`${key}: ${safe}`]
		}),
	}
}

/** Adds best-effort Lark delivery and keeps the host's existing loggers. */
export const layer = (settings: Options) =>
	Logger.layer(
		[
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient
				const clock = yield* Clock.Clock
				const capacity = settings.capacity ?? 256
				const aggregationCapacity = settings.aggregationCapacity ?? 128
				const windowMs = settings.windowMs ?? 60_000
				const intervalMs = settings.intervalMs ?? 1000
				const queue = yield* Queue.dropping<Notification, Cause.Done>(capacity)
				let aggregates = HashMap.empty<string, Aggregate>()
				let accepting = true
				let dropped = 0
				let inFlight = 0
				let lastAttempt = -Infinity
				const local = (
					message: string,
					details: Readonly<Record<string, unknown>>,
				) =>
					Effect.logWarning(message).pipe(
						Effect.annotateLogs({ ...details, "lark.exclude": true }),
					)
				const enqueue = (notification: Notification) => {
					if (!Queue.offerUnsafe(queue, notification)) dropped++
				}
				const expire = (now: number) => {
					HashMap.forEach(aggregates, (value, key) => {
						if (value.expires > now) return
						if (value.repeats > 0)
							enqueue({ event: value.event, repeats: value.repeats })
						aggregates = HashMap.remove(aggregates, key)
					})
				}
				const reportDrops = Effect.suspend(() => {
					const count = dropped
					dropped = 0
					return count === 0
						? Effect.void
						: local("Lark notifications were dropped", { count })
				})
				const send = Effect.fn("Lark.send")(function* (
					notification: Notification,
				) {
					const wait =
						lastAttempt + intervalMs - (yield* clock.currentTimeMillis)
					if (wait > 0) yield* Effect.sleep(wait)
					lastAttempt = yield* clock.currentTimeMillis
					const timestamp = String(Math.floor(lastAttempt / 1000))
					const secret = Redacted.value(settings.signingSecret)
					const event = notification.event
					const text = [
						`Platform ${event.level}: ${notification.repeats > 0 ? "Repeated failure" : "Operation failed"}`,
						`environment: ${identifier(settings.environment, "unknown")}`,
						`version: ${identifier(settings.version, "unknown")}`,
						`instance: ${identifier(settings.instance, "unknown")}`,
						`time: ${event.time}`,
						`eventId: ${event.id}`,
						`source: ${event.source}`,
						`operation: ${event.operation}`,
						`errorType: ${event.errorType}`,
						`location: ${event.location}`,
						...event.correlation,
						...(notification.repeats > 0
							? [`additionalOccurrences: ${notification.repeats}`]
							: []),
					].join("\n")
					const request = HttpClientRequest.post(
						Redacted.value(settings.webhookUrl),
					).pipe(
						HttpClientRequest.bodyJsonUnsafe({
							msg_type: "text",
							content: { text },
							...(secret === ""
								? {}
								: {
										timestamp,
										sign: createHmac("sha256", `${timestamp}\n${secret}`)
											.update("")
											.digest("base64"),
									}),
						}),
					)
					return yield* Effect.gen(function* () {
						const response = yield* client
							.execute(request)
							.pipe(
								Effect.mapError(
									() =>
										new DeliveryError({ retryable: true, reason: "network" }),
								),
							)
						if (response.status < 200 || response.status >= 300)
							return yield* new DeliveryError({
								retryable: response.status === 429 || response.status >= 500,
								reason: `http_${response.status}`,
							})
						const result = yield* response.json.pipe(
							Effect.flatMap(decodeResult),
							Effect.mapError(
								() =>
									new DeliveryError({
										retryable: false,
										reason: "invalid_response",
									}),
							),
						)
						const code = result.code
						if (code !== 0)
							return yield* new DeliveryError({
								retryable: code === 9499 || code === 99991400,
								reason: `lark_${code}`,
							})
					}).pipe(
						Effect.timeoutOrElse({
							duration: settings.requestTimeoutMs ?? 2000,
							orElse: () =>
								Effect.fail(
									new DeliveryError({ retryable: true, reason: "timeout" }),
								),
						}),
					)
				})
				const worker = yield* Effect.forever(
					Effect.gen(function* () {
						const notification = yield* Queue.take(queue)
						inFlight = 1
						yield* send(notification).pipe(
							Effect.retry({ times: 2, while: (error) => error.retryable }),
							Effect.catch((error) =>
								local("Lark notification delivery failed", {
									reason: error.reason,
									eventId: notification.event.id,
								}),
							),
							Effect.catchCauseIf(
								(cause) => !Cause.hasInterruptsOnly(cause),
								() => local("Lark notification worker failed", {}),
							),
						)
						inFlight = 0
					}),
				).pipe(
					Effect.catchTag("Done", () => Effect.void),
					Effect.forkScoped,
				)
				const timer = yield* Effect.forever(
					Effect.sleep(Math.min(windowMs, 1000)).pipe(
						Effect.andThen(
							Effect.sync(() => expire(clock.currentTimeMillisUnsafe())),
						),
						Effect.andThen(reportDrops),
					),
				).pipe(Effect.forkScoped)
				yield* Effect.addFinalizer(() =>
					Effect.gen(function* () {
						accepting = false
						yield* Fiber.interrupt(timer)
						expire(Infinity)
						yield* Queue.end(queue)
						const flushed = yield* Fiber.join(worker).pipe(
							Effect.timeoutOption(settings.shutdownTimeoutMs ?? 5000),
							Effect.interruptible,
						)
						if (Option.isNone(flushed)) {
							dropped += Queue.sizeUnsafe(queue) + inFlight
							yield* Fiber.interrupt(worker)
						}
						yield* Queue.shutdown(queue)
						yield* reportDrops
					}),
				)
				return Logger.make((log) => {
					if (!accepting) return
					const event = eventFrom(log)
					if (event === undefined) return
					const now = clock.currentTimeMillisUnsafe()
					expire(now)
					const key = JSON.stringify([
						event.source,
						event.operation,
						event.errorType,
						event.location,
					])
					const existing = HashMap.get(aggregates, key)
					if (Option.isSome(existing)) {
						aggregates = HashMap.set(aggregates, key, {
							...existing.value,
							repeats: existing.value.repeats + 1,
						})
						return
					}
					if (HashMap.size(aggregates) >= aggregationCapacity) {
						dropped++
						return
					}
					aggregates = HashMap.set(aggregates, key, {
						event,
						expires: now + windowMs,
						repeats: 0,
					})
					enqueue({ event, repeats: 0 })
				})
			}),
		],
		{ mergeWithExisting: true },
	)
