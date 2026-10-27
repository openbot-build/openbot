import { Redacted } from "effect"
/**
 * The driver for any service that speaks the E2B API, such as E2B, PPIO, or a
 * self-hosted E2B. It uses two APIs over plain HTTP, with no E2B SDK:
 *
 * - The platform API (`https://api.e2b.app`, spec in `spec/openapi.yml` of
 *   https://github.com/e2b-dev/E2B) makes, pauses, resumes and deletes sandboxes.
 *   It takes the key in the `X-API-Key` header.
 * - envd, the server inside each sandbox, at `https://49983-<sandbox ID>.<domain>`,
 *   runs commands and works with files (see `Envd.ts`).
 *
 * `make(credentials)` needs an `HttpClient` and gives a `Provider`. It does no I/O.
 */
import type { Computers as ComputerData } from "@openbot-build/domain"
import { Effect, Option, Ref, String as Str } from "effect"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	ComputerCallFailed,
	ComputerGone,
	Machine,
	type MachineState,
	Provider,
	type Spec,
	type RunRequest,
	type StartRequest,
} from "../Computer.ts"
import * as Desktop from "./Desktop.ts"
import * as Envd from "./Envd.ts"
import * as Background from "../../execution/Background.ts"
import {
	failed,
	field,
	fileBytes,
	fileContent,
	json,
	ok,
	pngSize,
	type Reply,
	send,
	string,
} from "../Http.ts"

export type Credentials = Extract<
	ComputerData.ComputerProviderCredentials,
	{ readonly kind: "e2b" }
>

export const defaultApiUrl = "https://api.e2b.app"
export const defaultDomain = "e2b.app"
export const defaultTemplate = "base"

/** The metadata key that tells OpenBot that a sandbox has a desktop. */
export const desktopKey = "openbot-desktop"

/**
 * Seconds until E2B pauses the sandbox by itself (`autoPause`). Each resume starts
 * the time again. OpenBot pauses idle Computers itself, so this is only a safety
 * net. One hour is the longest time on every E2B plan.
 */
const sandboxTimeout = 3600

const controlTimeoutMs = 30_000
const createTimeoutMs = 120_000

/**
 * The host where the sandbox of the connection serves a port. The address comes
 * from the stored sandbox domain or from E2B, so it can be wrong.
 */
const hostOf = (connection: Envd.Connection, port: number) =>
	Effect.try({
		try: () =>
			Str.replace(
				`${Envd.envdPort}-`,
				`${port}-`,
			)(new URL(connection.url).host),
		catch: (cause) =>
			ComputerCallFailed.make({
				message: `The E2B sandbox address ${connection.url} is not a valid URL`,
				retry: false,
				cause,
			}),
	})

const gone = (id: string) =>
	ComputerGone.make({ message: `The E2B sandbox ${id} does not exist` })

export const make = (credentials: Credentials) =>
	Effect.gen(function* () {
		const background = yield* Background.make
		const client = yield* HttpClient.HttpClient
		const api = credentials.apiUrl ?? defaultApiUrl

		const control = (
			request: HttpClientRequest.HttpClientRequest,
			timeoutMs = controlTimeoutMs,
		) =>
			send(
				client,
				request.pipe(
					HttpClientRequest.setHeaders({
						"x-api-key": Redacted.value(credentials.apiKey),
					}),
				),
				timeoutMs,
			)

		const connectionOf = (id: string, body: unknown): Envd.Connection => ({
			sandboxId: id,
			url: `https://${Envd.envdPort}-${id}.${credentials.sandboxDomain ?? string(body, "domain") ?? defaultDomain}`,
			accessToken: string(body, "envdAccessToken"),
		})

		/** Reads one sandbox. `Option.none()` when the sandbox does not exist. */
		const detail = (
			id: string,
		): Effect.Effect<Option.Option<unknown>, ComputerCallFailed> =>
			control(
				HttpClientRequest.get(`${api}/sandboxes/${encodeURIComponent(id)}`),
			).pipe(
				Effect.flatMap((reply) =>
					reply.status === 404
						? Effect.succeedNone
						: ok(reply)
							? Effect.succeedSome(json(reply))
							: Effect.fail(failed(reply, "Reading the E2B sandbox")),
				),
			)

		const stateOf = (
			id: string,
		): Effect.Effect<MachineState, ComputerCallFailed> =>
			Effect.map(detail(id), (body) => {
				if (Option.isNone(body)) return "gone"
				return string(body.value, "state") === "paused" ? "paused" : "running"
			})

		/** Resumes a paused sandbox, or only gets its address when it runs. */
		const connect = (id: string) =>
			control(
				HttpClientRequest.post(
					`${api}/sandboxes/${encodeURIComponent(id)}/connect`,
				).pipe(HttpClientRequest.bodyJsonUnsafe({ timeout: sandboxTimeout })),
				createTimeoutMs,
			).pipe(
				Effect.flatMap(
					(
						reply,
					): Effect.Effect<
						Envd.Connection,
						ComputerCallFailed | ComputerGone
					> =>
						reply.status === 404
							? Effect.fail(gone(id))
							: ok(reply)
								? Effect.succeed(connectionOf(id, json(reply)))
								: Effect.fail(failed(reply, "Resuming the E2B sandbox")),
				),
			)

		const pause = (
			id: string,
		): Effect.Effect<void, ComputerCallFailed | ComputerGone> =>
			control(
				HttpClientRequest.post(
					`${api}/sandboxes/${encodeURIComponent(id)}/pause`,
				),
				createTimeoutMs,
			).pipe(
				Effect.flatMap(
					(
						reply: Reply,
					): Effect.Effect<void, ComputerCallFailed | ComputerGone> =>
						reply.status === 404
							? Effect.fail(gone(id))
							: // 409 means that the sandbox is paused already.
								ok(reply) || reply.status === 409
								? Effect.void
								: Effect.fail(failed(reply, "Pausing the E2B sandbox")),
				),
			)

		const destroy = (id: string) =>
			control(
				HttpClientRequest.delete(`${api}/sandboxes/${encodeURIComponent(id)}`),
			).pipe(
				Effect.flatMap((reply) =>
					ok(reply) || reply.status === 404
						? Effect.void
						: Effect.fail(failed(reply, "Deleting the E2B sandbox")),
				),
			)

		const verify = control(HttpClientRequest.get(`${api}/sandboxes`)).pipe(
			Effect.flatMap((reply) =>
				ok(reply)
					? Effect.void
					: Effect.fail(failed(reply, "Checking the E2B key")),
			),
		)

		const create = (spec: Spec) =>
			control(
				HttpClientRequest.post(`${api}/sandboxes`).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						templateID:
							spec.template ??
							(spec.desktop ? Desktop.template : defaultTemplate),
						timeout: sandboxTimeout,
						autoPause: true,
						secure: true,
						metadata: {
							...spec.labels,
							[desktopKey]: spec.desktop ? "true" : "false",
						},
						envVars: spec.desktop ? { DISPLAY: Desktop.display } : {},
					}),
				),
				createTimeoutMs,
			).pipe(
				Effect.flatMap((reply) => {
					const id = string(json(reply), "sandboxID")
					return ok(reply) && id !== undefined
						? Effect.succeed({ ref: id })
						: Effect.fail(failed(reply, "Making the E2B sandbox"))
				}),
			)

		const attach = (id: string) =>
			Effect.gen(function* () {
				const found = yield* detail(id)
				if (Option.isNone(found)) return yield* gone(id)
				const body = found.value
				const running = string(body, "state") !== "paused"
				const cached = yield* Ref.make(
					running && string(body, "envdAccessToken") !== undefined
						? Option.some(connectionOf(id, body))
						: Option.none<Envd.Connection>(),
				)
				const unavailable = () =>
					ComputerCallFailed.make({
						message:
							"The E2B sandbox needs a resume through its Computer execution.",
						retry: true,
					})
				const connection = Effect.flatMap(
					Ref.get(cached),
					Option.match({
						onSome: Effect.succeed,
						onNone: () => Effect.fail(unavailable()),
					}),
				)
				// A lost connection must not make a hidden resume or repeat an unknown command.
				const withEnvd = <A, R = never>(
					call: (
						connection: Envd.Connection,
					) => Effect.Effect<A, ComputerCallFailed | Envd.SandboxAway, R>,
				): Effect.Effect<A, ComputerCallFailed | ComputerGone, R> =>
					Effect.flatMap(connection, call).pipe(
						Effect.catchTag("SandboxAway", () =>
							Ref.set(cached, Option.none()).pipe(
								Effect.andThen(Effect.fail(unavailable())),
							),
						),
					)

				const run = (request: RunRequest) =>
					withEnvd((current) => Envd.run(client, current, request, background))

				const shell = {
					start: (request: StartRequest) =>
						withEnvd((current) =>
							Envd.start(client, current, request, background),
						),
					read: (path: string, encoding: ComputerData.FileEncoding) =>
						withEnvd((current) => Envd.read(client, current, path)).pipe(
							Effect.map((bytes) => fileContent(path, encoding, bytes)),
						),
					write: (file: ComputerData.FileContent) =>
						Effect.gen(function* () {
							const bytes = yield* fileBytes(file)
							return yield* withEnvd((current) =>
								Envd.write(client, current, file.path, bytes),
							)
						}),
					list: (path: string) =>
						withEnvd((current) => Envd.list(client, current, path)),
					remove: (path: string) =>
						withEnvd((current) => Envd.remove(client, current, path)),
				}

				/** Runs a desktop script and fails when it fails. */
				const script = (command: string, timeout = 120) =>
					Effect.flatMap(
						run({ command, env: { DISPLAY: Desktop.display }, timeout }),
						(result) =>
							result.exitCode === 0
								? Effect.succeed(result.stdout)
								: Effect.fail(
										ComputerCallFailed.make({
											message: `The desktop command failed: ${Str.takeRight(result.stderr || result.stdout, 300) || "it did not finish in time"}`,
											retry: false,
										}),
									),
					)

				const desktop =
					string(field(body, "metadata"), desktopKey) === "true"
						? {
								screenshot: Effect.gen(function* () {
									yield* script(Desktop.screenshot)
									const bytes = yield* withEnvd((current) =>
										Envd.read(client, current, Desktop.screenshotPath),
									)
									const size = pngSize(bytes) ?? {
										width: Desktop.width,
										height: Desktop.height,
									}
									return {
										mediaType: "image/png",
										data: Base64.encode(bytes),
										...size,
									} satisfies ComputerData.Screenshot
								}),
								act: (actions: ReadonlyArray<ComputerData.DesktopAction>) =>
									Effect.asVoid(script(Desktop.actions(actions))),
								stream: Effect.gen(function* () {
									const key = Str.trim(yield* script(Desktop.stream))
									const host = yield* hostOf(
										yield* connection,
										Desktop.streamPort,
									)
									const query = new URLSearchParams({
										autoconnect: "true",
										resize: "scale",
										password: key,
									})
									return {
										url: `https://${host}/vnc.html?${query}`,
										expiresAt: null,
									} satisfies ComputerData.DesktopStream
								}),
							}
						: undefined

				return new Machine({
					shell,
					pausable: {
						pause: Effect.tap(pause(id), () => Ref.set(cached, Option.none())),
						resume: Effect.flatMap(connect(id), (fresh) =>
							Ref.set(cached, Option.some(fresh)),
						),
					},
					...(desktop === undefined ? {} : { desktop }),
					ports: {
						open: (port: number) =>
							Effect.flatMap(connection, (current) =>
								Effect.map(hostOf(current, port), (host) => `https://${host}`),
							),
					},
					state: stateOf(id),
					destroy: destroy(id),
				})
			})

		return new Provider({ kind: "e2b", verify, create, attach })
	})
