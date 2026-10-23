import { ComputersApi } from "@openbot-build/api"
import { Effect, Option } from "effect"
import { HttpClient } from "effect/http"
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

const tagOf = (value: unknown): unknown =>
	typeof value === "object" && value !== null && "_tag" in value
		? value._tag
		: undefined

const reasonOf = (value: unknown): unknown =>
	typeof value === "object" && value !== null && "reason" in value
		? value.reason
		: undefined

const explain =
	(url: string) =>
	(error: unknown): Config.ComputerError => {
		const tag = tagOf(error)
		const message =
			tag === "PairingInvalid"
				? "OpenBot ended this pairing. Someone denied it, or it is too old. Run 'openbot computer pair' again."
				: tag === "ComputersUnavailable"
					? "This OpenBot does not have Computers turned on."
					: tag === "HttpClientError" &&
						  tagOf(reasonOf(error)) === "TransportError"
						? `Could not reach OpenBot at ${url}.`
						: `OpenBot did not answer as expected: ${error instanceof Error ? error.message : String(error)}`
		return new Config.ComputerError({ message })
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
	HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const url = yield* Config.parseOrigin(options.url)
		const saved = yield* Config.read(options.file)
		const machineId = Option.match(saved, {
			onNone: Config.makeMachineId,
			onSome: (config) => config.machineId,
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
			if (Date.now() >= pairing.expiresAt)
				return yield* new Config.ComputerError({
					message:
						"Nobody approved the code in time. Run 'openbot computer pair' again.",
				})
			yield* Effect.sleep(intervalMs)
			const status = yield* poll.pipe(
				Effect.asSome,
				Effect.catch((error) =>
					tagOf(error) === "PairingInvalid" ||
					tagOf(error) === "ComputersUnavailable"
						? Effect.fail(explain(url)(error))
						: // The network can fail for a moment. Ask again at the next interval.
							Effect.succeedNone,
				),
			)
			if (Option.isSome(status) && status.value._tag === "Approved") {
				const config = { url, token: status.value.token, machineId }
				yield* Config.write(options.file, config)
				return { computer: status.value.computer, config }
			}
		}
	})
