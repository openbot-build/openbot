import { ComputersApi } from "@openbot-build/api"
import {
	Cause,
	Clock,
	type Crypto,
	Effect,
	type FileSystem,
	Option,
	type Path,
	Redacted,
	type Schema,
} from "effect"
import { HttpClient, type HttpClientError } from "effect/http"
import { HttpApi, HttpApiClient } from "effect/http-api"
import * as Config from "./Config.ts"
import * as Machine from "./Machine.ts"

/** Only the calls of a machine. They need no API key. */
const HooksApi = HttpApi.make("computerHooks").add(
	ComputersApi.ComputerHooksApi,
)

export interface Output {
	/** Tells the person the code to approve. */
	readonly showCode: (
		pairing: ComputersApi.Pairing,
		approveUrl: string,
	) => Effect.Effect<void>
}

/** The ways a pairing call can fail. */
type PairingFailure =
	| ComputersApi.PairingInvalid
	| ComputersApi.ComputersUnavailable
	| HttpClientError.HttpClientError
	| Schema.SchemaError

const explain =
	(url: string) =>
	(error: PairingFailure): Config.ComputerError => {
		switch (error._tag) {
			case "PairingInvalid":
				return Config.ComputerError.make({
					message:
						"OpenBot ended this pairing. Someone denied it, or it is too old. Run 'openbot computer pair' again.",
					cause: error,
				})
			case "ComputersUnavailable":
				return Config.ComputerError.make({
					message: "This OpenBot does not have Computers turned on.",
					cause: error,
				})
			case "HttpClientError":
				if (error.reason._tag === "TransportError")
					return Config.ComputerError.make({
						message: Option.match(Config.errorText(error.reason.cause), {
							onNone: () => `Could not reach OpenBot at ${url}.`,
							onSome: (reason) =>
								`Could not reach OpenBot at ${url} (${reason}).`,
						}),
						cause: error,
					})
		}
		return Config.ComputerError.make({
			message: `OpenBot did not answer as expected: ${error.message}`,
			cause: error,
		})
	}

/**
 * Pairs this machine with OpenBot and saves the token in the config file.
 * It keeps the machine ID of an earlier pairing, so OpenBot knows it is the same machine.
 * It does not connect.
 */
export const pair = (options: {
	readonly url: string
	readonly file: string
	readonly output: Output
}): Effect.Effect<
	{
		readonly computer: ComputersApi.ComputerId
		readonly config: Config.ComputerConfig
	},
	Config.ComputerError,
	HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
	Effect.gen(function* () {
		const url = yield* Config.parseOrigin(options.url)
		const saved = yield* Config.read(options.file)
		const machineId = yield* Option.match(saved, {
			onNone: () => Config.makeMachineId,
			onSome: (config) => Effect.succeed(config.machineId),
		})
		const client = yield* HttpApiClient.group(HooksApi, {
			group: "computerHooks",
			httpClient: yield* HttpClient.HttpClient,
			baseUrl: url,
		})
		const pairing = yield* client
			.startPairing({
				payload: { ...Machine.hello(), hostname: Machine.name(), machineId },
			})
			.pipe(Effect.mapError(explain(url)))
		yield* options.output.showCode(
			pairing,
			`${url}/v1/computer-pairings/${encodeURIComponent(pairing.code)}/approve`,
		)
		const poll = client.pollPairing({
			params: { pairingId: pairing.id },
			headers: { authorization: `Bearer ${pairing.secret}` },
		})
		const intervalMs = Math.max(1, pairing.interval) * 1000
		while (true) {
			if ((yield* Clock.currentTimeMillis) >= pairing.expiresAt)
				return yield* Config.ComputerError.make({
					message:
						"Nobody approved the code in time. Run 'openbot computer pair' again.",
				})
			yield* Effect.sleep(intervalMs)
			const status = yield* poll.pipe(
				Effect.asSome,
				// The network can fail for a moment, and a proxy can answer 502, 503 or 504
				// while OpenBot starts again. Ask again at the next interval. Every other
				// failure does not go away, so it stops the pairing.
				Effect.catchTag("HttpClientError", (error) => {
					const code = error.response?.status
					return error.reason._tag === "TransportError" ||
						(code !== undefined && (code >= 500 || code === 429))
						? Effect.logDebug(
								"A poll of the pairing failed. It asks again at the next interval.",
								Cause.fail(error),
							).pipe(Effect.as(Option.none()))
						: Effect.fail(error)
				}),
				Effect.mapError(explain(url)),
			)
			if (Option.isSome(status) && status.value._tag === "Approved") {
				const config = {
					url,
					token: Redacted.make(status.value.token),
					machineId,
				}
				yield* Config.write(options.file, config)
				return { computer: status.value.computer, config }
			}
		}
	})
