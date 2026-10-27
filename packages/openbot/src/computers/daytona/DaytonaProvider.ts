import { Redacted } from "effect"
/**
 * The driver for Daytona, hosted or self-hosted. It uses two APIs over plain HTTP,
 * with no Daytona SDK. Both take the key as a bearer token.
 *
 * - The Daytona API (`<apiUrl>/api`, such as `https://app.daytona.io/api`) makes,
 *   stops, starts and deletes sandboxes, and makes preview links for ports.
 * - The toolbox API of each sandbox, at `<toolboxProxyUrl>/<sandbox ID>`, runs
 *   commands, works with files and controls the desktop (`/computeruse/*`).
 *
 * The routes come from the `@daytonaio/api-client` and `@daytonaio/toolbox-api-client`
 * packages, which Daytona makes from its OpenAPI documents.
 *
 * `make(credentials)` needs an `HttpClient` and gives a `Provider`. It does no I/O.
 */
import type { Computers as ComputerData } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Clock,
	Effect,
	Fiber,
	Option,
	Random,
	Record as Rec,
	Ref,
	Result,
	String as Str,
} from "effect"
import { Base64, Hex } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as Background from "../../execution/Background.ts"
import * as Report from "../../errors/Report.ts"
import {
	ComputerCallFailed,
	ComputerGone,
	Machine,
	type MachineState,
	Provider,
	type Spec,
	type Process,
	type StartRequest,
} from "../Computer.ts"
import * as ProcessSink from "../Process.ts"
import {
	failed,
	field,
	fileBytes,
	fileContent,
	json,
	number,
	ok,
	pngSize,
	quote,
	type Reply,
	send,
	string,
	text,
} from "../Http.ts"

export type Credentials = Extract<
	ComputerData.ComputerProviderCredentials,
	{ readonly kind: "daytona" }
>

export const defaultApiUrl = "https://app.daytona.io"

/** The label that tells OpenBot that a sandbox has a desktop. */
export const desktopKey = "openbot-desktop"

/** The port where the Daytona desktop serves noVNC. */
export const streamPort = 6080

/** Seconds that a desktop stream link works. */
const streamSeconds = 3600
/** Seconds that a port link works. 24 hours is the longest time that Daytona allows. */
const portSeconds = 86_400

const controlTimeoutMs = 30_000
const startTimeoutMs = 180_000
/** After a check finds the sandbox running, calls skip the check for this time. */
const freshMs = 60_000

/** Daytona has many states. OpenBot needs four. */
export const stateOf = (state: string | undefined): MachineState => {
	switch (state) {
		case "started":
			return "running"
		case "stopped":
		case "stopping":
		case "archived":
		case "archiving":
		case "paused":
		case "pausing":
			return "paused"
		case "destroyed":
		case "destroying":
		case "error":
		case "build_failed":
			return "gone"
		default:
			return "starting"
	}
}

const gone = (id: string) =>
	ComputerGone.make({ message: `The Daytona sandbox ${id} does not exist` })

const withoutEndSlash = Str.replace(/\/$/, "")

const entry = (value: unknown): ComputerData.FileEntry => {
	const modified = string(value, "modTime") ?? string(value, "modifiedAt")
	const parsed = modified === undefined ? Number.NaN : Date.parse(modified)
	return {
		name: string(value, "name") ?? "",
		// The mode is the text of a Go file mode, such as `Lrwxrwxrwx` for a link.
		kind: Str.startsWith("L")(string(value, "mode") ?? "")
			? "link"
			: field(value, "isDir") === true
				? "directory"
				: "file",
		size: number(value, "size") ?? 0,
		modifiedAt: Number.isFinite(parsed) ? parsed : 0,
	}
}

export const make = (credentials: Credentials) =>
	Effect.gen(function* () {
		const background = yield* Background.make
		const report = yield* Report.make
		const client = yield* HttpClient.HttpClient
		const api = `${credentials.apiUrl ?? defaultApiUrl}/api`
		const auth = {
			authorization: `Bearer ${Redacted.value(credentials.apiKey)}`,
			"x-daytona-source": "openbot",
		}

		const call = (
			request: HttpClientRequest.HttpClientRequest,
			timeoutMs = controlTimeoutMs,
		) =>
			send(client, request.pipe(HttpClientRequest.setHeaders(auth)), timeoutMs)

		const sandboxUrl = (id: string, rest = "") =>
			`${api}/sandbox/${encodeURIComponent(id)}${rest}`

		/** Reads one sandbox. `none` when the sandbox does not exist. */
		const detail = (
			id: string,
		): Effect.Effect<Option.Option<unknown>, ComputerCallFailed> =>
			call(HttpClientRequest.get(sandboxUrl(id))).pipe(
				Effect.flatMap((reply) =>
					reply.status === 404
						? Effect.succeedNone
						: ok(reply)
							? Effect.succeedSome(json(reply))
							: Effect.fail(failed(reply, "Reading the Daytona sandbox")),
				),
			)

		const expect =
			(what: string, path?: string) =>
			(reply: Reply): Effect.Effect<Reply, ComputerCallFailed> =>
				ok(reply)
					? Effect.succeed(reply)
					: path !== undefined && reply.status === 404
						? Effect.fail(
								ComputerCallFailed.make({
									message: `The path ${path} is not there.`,
									retry: false,
									missingPath: path,
								}),
							)
						: Effect.fail(failed(reply, what))

		const verify = call(HttpClientRequest.get(`${api}/api-keys/current`)).pipe(
			Effect.flatMap(expect("Checking the Daytona key")),
			Effect.asVoid,
		)

		const create = (spec: Spec) =>
			call(
				HttpClientRequest.post(`${api}/sandbox`).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						...(spec.template === undefined ? {} : { snapshot: spec.template }),
						...(credentials.target === undefined
							? {}
							: { target: credentials.target }),
						labels: {
							...spec.labels,
							[desktopKey]: spec.desktop ? "true" : "false",
						},
					}),
				),
				startTimeoutMs,
			).pipe(
				Effect.flatMap((reply) => {
					const id = string(json(reply), "id")
					return ok(reply) && id !== undefined
						? Effect.succeed({ ref: id })
						: Effect.fail(failed(reply, "Making the Daytona sandbox"))
				}),
			)

		const destroy = (id: string) =>
			call(HttpClientRequest.delete(sandboxUrl(id))).pipe(
				Effect.flatMap((reply) =>
					ok(reply) || reply.status === 404
						? Effect.void
						: Effect.fail(failed(reply, "Deleting the Daytona sandbox")),
				),
			)

		const attach = (id: string) =>
			Effect.gen(function* () {
				const found = yield* detail(id)
				if (Option.isNone(found)) return yield* gone(id)
				const body = found.value
				/** The toolbox address, and when OpenBot last saw the sandbox run. */
				const running = yield* Ref.make(
					Option.none<{ readonly toolbox: string; readonly at: number }>(),
				)

				const toolboxOf = (sandbox: unknown) =>
					Effect.gen(function* () {
						const proxy = string(sandbox, "toolboxProxyUrl")
						if (proxy !== undefined && proxy !== "")
							return `${withoutEndSlash(proxy)}/${id}`
						const reply = yield* call(
							HttpClientRequest.get(sandboxUrl(id, "/toolbox-proxy-url")),
						).pipe(
							Effect.flatMap(expect("Reading the Daytona toolbox address")),
						)
						const url = string(json(reply), "url")
						if (url === undefined || url === "")
							return yield* ComputerCallFailed.make({
								message: "Daytona did not give the toolbox address.",
								retry: true,
							})
						return `${withoutEndSlash(url)}/${id}`
					})

				const start = call(
					HttpClientRequest.post(sandboxUrl(id, "/start")),
					startTimeoutMs,
				).pipe(Effect.flatMap(expect("Starting the Daytona sandbox")))

				/** Only the explicit resume method may start a stopped sandbox. */
				const connect = (
					resume: boolean,
				): Effect.Effect<string, ComputerCallFailed | ComputerGone> =>
					Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis
						const known = yield* Ref.get(running)
						if (Option.isSome(known) && now - known.value.at < freshMs)
							return known.value.toolbox
						let started = false
						while ((yield* Clock.currentTimeMillis) - now < startTimeoutMs) {
							const current = yield* detail(id)
							if (Option.isNone(current)) return yield* gone(id)
							const state = stateOf(string(current.value, "state"))
							if (state === "gone") return yield* gone(id)
							if (state === "running") {
								const toolbox = yield* toolboxOf(current.value)
								yield* Ref.set(
									running,
									Option.some({ toolbox, at: yield* Clock.currentTimeMillis }),
								)
								return toolbox
							}
							const settled = ["stopped", "archived", "paused"].includes(
								string(current.value, "state") ?? "",
							)
							if (state === "paused" && settled && !started) {
								if (!resume)
									return yield* ComputerCallFailed.make({
										message:
											"The Daytona sandbox needs a resume through its Computer execution.",
										retry: true,
									})
								yield* start
								started = true
							}
							yield* Effect.sleep(1000)
						}
						return yield* ComputerCallFailed.make({
							message: "The Daytona sandbox did not start in time",
							retry: true,
						})
					})

				const ensure = connect(false)

				const toolbox = (
					build: (base: string) => HttpClientRequest.HttpClientRequest,
					what: string,
					timeoutMs = controlTimeoutMs,
					path?: string,
				) =>
					Effect.flatMap(ensure, (base) =>
						call(build(base), timeoutMs).pipe(
							Effect.flatMap(expect(what, path)),
						),
					)

				const query = (
					base: string,
					path: string,
					params: Record<string, string>,
				) => `${base}${path}?${new URLSearchParams(params)}`

				/**
				 * A command in a session of the toolbox. The toolbox has no terminal for a
				 * session, so OpenBot reads the log again and again and gives what is new.
				 */
				const startCommand = (request: StartRequest) =>
					Effect.gen(function* () {
						if (request.tty)
							return yield* ComputerCallFailed.make({
								message:
									"A Daytona Computer gives no terminal to a command in OpenBot. Run it without tty.",
								retry: false,
							})
						// The ID only needs to be unique in the sandbox. It is not a secret.
						const random = yield* Effect.replicateEffect(
							Random.nextIntBetween(0, 255),
							8,
						)
						const sessionId = `openbot-${Hex.encode(Uint8Array.from(random))}`
						const sessionPath = `/process/session/${sessionId}`
						const address = yield* ensure
						/**
						 * Closes the session once. It does not go through `ensure`, so it never
						 * starts a stopped sandbox only to close a session. On a stopped
						 * sandbox it fails fast, and the log keeps the failure.
						 */
						const close = yield* Effect.cached(
							call(
								HttpClientRequest.delete(`${address}${sessionPath}`),
								10_000,
							).pipe(
								Effect.flatMap(expect("Closing the command session")),
								background.logFailure(
									"OpenBot could not close a Daytona command session",
								),
							),
						)
						yield* Effect.acquireRelease(
							call(
								HttpClientRequest.post(`${address}/process/session`).pipe(
									HttpClientRequest.bodyJsonUnsafe({ sessionId }),
								),
							).pipe(Effect.flatMap(expect("Starting a command session"))),
							() => close,
						)
						const prefix = Arr.join(
							[
								...(request.cwd === undefined
									? []
									: [`cd ${quote(request.cwd)} &&`]),
								...Arr.map(
									Rec.toEntries(request.env ?? {}),
									([key, value]) => `export ${key}=${quote(value)};`,
								),
							],
							" ",
						)
						const started = yield* toolbox(
							(base) =>
								HttpClientRequest.post(`${base}${sessionPath}/exec`).pipe(
									HttpClientRequest.bodyJsonUnsafe({
										command: Str.trim(
											`${prefix} bash -lc ${quote(request.command)}`,
										),
										runAsync: true,
									}),
								),
							"Starting the command",
						)
						const commandId =
							string(json(started), "cmdId") ??
							string(json(started), "commandId")
						if (commandId === undefined)
							return yield* ComputerCallFailed.make({
								message: "Daytona did not give the command an ID.",
								retry: true,
							})
						const commandPath = `${sessionPath}/command/${commandId}`
						const sink = yield* ProcessSink.make
						const encoder = new TextEncoder()
						let seen = 0
						const poll = Effect.gen(function* () {
							while (true) {
								const logs = yield* toolbox(
									(base) => HttpClientRequest.get(`${base}${commandPath}/logs`),
									"Reading the output",
								)
								const all = text(logs)
								if (all.length > seen) {
									yield* sink.push(encoder.encode(Str.slice(seen)(all)))
									seen = all.length
								}
								const detail = json(
									yield* toolbox(
										(base) => HttpClientRequest.get(`${base}${commandPath}`),
										"Reading the command",
									),
								)
								const exitCode = number(detail, "exitCode")
								if (exitCode !== undefined) {
									// Output can come after the last read, so read once more.
									const last = text(
										yield* toolbox(
											(base) =>
												HttpClientRequest.get(`${base}${commandPath}/logs`),
											"Reading the output",
										),
									)
									if (last.length > seen)
										yield* sink.push(encoder.encode(Str.slice(seen)(last)))
									return yield* sink.end({ code: exitCode, signal: null })
								}
								yield* Effect.sleep("250 millis")
							}
						}).pipe(
							// A failure still ends the sink, so a reader does not wait for ever.
							Effect.catchCause((cause) =>
								Effect.andThen(
									Cause.hasInterruptsOnly(cause)
										? Effect.void
										: report(
												"OpenBot could not read a Daytona command",
												cause,
											).pipe(
												Effect.annotateLogs({
													sandbox: id,
													command: commandId,
												}),
											),
									sink.end({
										code: null,
										signal: null,
										error: "OpenBot could not read the command.",
									}),
								),
							),
						)
						const reader = yield* Effect.forkScoped(poll)
						const process: Process = {
							output: sink.output,
							exit: sink.exit,
							write: (data) =>
								toolbox(
									(base) =>
										HttpClientRequest.post(`${base}${commandPath}/input`).pipe(
											HttpClientRequest.bodyJsonUnsafe({
												data: new TextDecoder().decode(data),
											}),
										),
									"Sending input",
								).pipe(Effect.asVoid),
							resize: () => Effect.void,
							signal: (signal) =>
								signal === "SIGKILL" || signal === "SIGTERM"
									? // Stop reading first, so the read of a closed session does not fail.
										Fiber.interrupt(reader).pipe(
											Effect.andThen(close),
											Effect.andThen(
												sink.end({
													code: null,
													signal,
													error: "The session was closed.",
												}),
											),
										)
									: Effect.fail(
											ComputerCallFailed.make({
												message: `A Daytona Computer cannot send ${signal} to a command. Close the session to stop it.`,
												retry: false,
											}),
										),
						}
						return process
					})

				const shell = {
					start: startCommand,
					read: (path: string, encoding: ComputerData.FileEncoding) =>
						toolbox(
							(base) =>
								HttpClientRequest.get(query(base, "/files/download", { path })),
							`Reading ${path}`,
							controlTimeoutMs,
							path,
						).pipe(
							Effect.map((reply) => fileContent(path, encoding, reply.body)),
						),
					write: (file: ComputerData.FileContent) =>
						Effect.gen(function* () {
							const bytes = yield* fileBytes(file)
							const form = new FormData()
							form.append("files[0].path", file.path)
							form.append("files[0].file", new Blob([bytes.slice()]), file.path)
							yield* toolbox(
								(base) =>
									HttpClientRequest.post(`${base}/files/bulk-upload`).pipe(
										HttpClientRequest.bodyFormData(form),
									),
								`Writing ${file.path}`,
								120_000,
							)
						}),
					list: (path: string) =>
						toolbox(
							(base) => HttpClientRequest.get(query(base, "/files", { path })),
							`Listing ${path}`,
							controlTimeoutMs,
							path,
						).pipe(
							Effect.map((reply) => {
								const entries = json(reply)
								return Arr.isArray(entries) ? Arr.map(entries, entry) : []
							}),
						),
					remove: (path: string) =>
						toolbox(
							(base) =>
								HttpClientRequest.delete(
									query(base, "/files", { path, recursive: "true" }),
								),
							`Removing ${path}`,
							controlTimeoutMs,
							path,
						).pipe(Effect.asVoid),
				}

				/** Signed preview links carry their token, so anyone with the link can use it. */
				const signed = (port: number, seconds: number) =>
					call(
						HttpClientRequest.get(
							`${sandboxUrl(id, `/ports/${port}/signed-preview-url`)}?${new URLSearchParams({ expiresInSeconds: String(seconds) })}`,
						),
					).pipe(
						Effect.flatMap(expect("Making the Daytona preview link")),
						Effect.flatMap((reply) => {
							const url = string(json(reply), "url")
							return url === undefined || url === ""
								? Effect.fail(
										ComputerCallFailed.make({
											message: "Daytona did not give a preview link.",
											retry: true,
										}),
									)
								: Effect.succeed(withoutEndSlash(url))
						}),
					)

				/** Starts Xvfb, XFCE, x11vnc and noVNC, when they do not run yet. */
				const desktopReady = Effect.gen(function* () {
					const status = yield* toolbox(
						(base) => HttpClientRequest.get(`${base}/computeruse/status`),
						"Reading the desktop status",
					)
					if (string(json(status), "status") === "active") return
					yield* toolbox(
						(base) => HttpClientRequest.post(`${base}/computeruse/start`),
						"Starting the desktop",
						120_000,
					)
				})

				const post = (path: string, body: unknown, what: string) =>
					toolbox(
						(base) =>
							HttpClientRequest.post(`${base}${path}`).pipe(
								HttpClientRequest.bodyJsonUnsafe(body),
							),
						what,
					)

				const action = (step: ComputerData.DesktopAction) => {
					switch (step._tag) {
						case "Click":
							return post(
								"/computeruse/mouse/click",
								{
									x: step.x,
									y: step.y,
									button: step.button ?? "left",
									double: step.double === true,
								},
								"Clicking",
							)
						case "Move":
							return post(
								"/computeruse/mouse/move",
								{ x: step.x, y: step.y },
								"Moving the mouse",
							)
						case "Drag":
							return post(
								"/computeruse/mouse/drag",
								{
									startX: step.fromX,
									startY: step.fromY,
									endX: step.toX,
									endY: step.toY,
									button: "left",
								},
								"Dragging",
							)
						case "Scroll":
							return Effect.gen(function* () {
								if (step.deltaY !== 0)
									yield* post(
										"/computeruse/mouse/scroll",
										{
											x: step.x,
											y: step.y,
											direction: step.deltaY < 0 ? "up" : "down",
											amount: Math.abs(step.deltaY),
										},
										"Scrolling",
									)
								if (step.deltaX !== 0)
									yield* post(
										"/computeruse/mouse/scroll",
										{
											x: step.x,
											y: step.y,
											direction: step.deltaX < 0 ? "left" : "right",
											amount: Math.abs(step.deltaX),
										},
										"Scrolling",
									)
							})
						case "Type":
							return post(
								"/computeruse/keyboard/type",
								{ text: step.text },
								"Typing",
							)
						case "Key":
							return step.keys.length === 1
								? post(
										"/computeruse/keyboard/key",
										{ key: step.keys[0] },
										"Pressing a key",
									)
								: post(
										"/computeruse/keyboard/hotkey",
										{ keys: Arr.join(step.keys, "+") },
										"Pressing keys",
									)
					}
				}

				const desktop =
					string(field(body, "labels"), desktopKey) === "true"
						? {
								screenshot: Effect.gen(function* () {
									yield* desktopReady
									const reply = yield* toolbox(
										(base) =>
											HttpClientRequest.get(
												query(base, "/computeruse/screenshot", {
													showCursor: "true",
												}),
											),
										"Taking a screenshot",
									)
									const data = string(json(reply), "screenshot") ?? ""
									const size = pngSize(
										Result.getOrElse(
											Base64.decode(Str.slice(0, 64)(data)),
											() => new Uint8Array(0),
										),
									)
									if (size === undefined)
										return yield* ComputerCallFailed.make({
											message: "The screenshot of Daytona is not a PNG image",
											retry: true,
										})
									return {
										mediaType: "image/png",
										data,
										...size,
									} satisfies ComputerData.Screenshot
								}),
								act: (actions: ReadonlyArray<ComputerData.DesktopAction>) =>
									Effect.gen(function* () {
										yield* desktopReady
										for (const step of actions) yield* action(step)
									}),
								stream: Effect.gen(function* () {
									yield* desktopReady
									const url = yield* signed(streamPort, streamSeconds)
									const now = yield* Clock.currentTimeMillis
									return {
										url: `${url}/vnc.html?${new URLSearchParams({ autoconnect: "true", resize: "scale" })}`,
										expiresAt: now + streamSeconds * 1000,
									} satisfies ComputerData.DesktopStream
								}),
							}
						: undefined

				const stop = call(
					HttpClientRequest.post(sandboxUrl(id, "/stop")),
					startTimeoutMs,
				).pipe(
					Effect.flatMap(
						(reply): Effect.Effect<void, ComputerCallFailed | ComputerGone> =>
							reply.status === 404
								? Effect.fail(gone(id))
								: ok(reply)
									? Effect.void
									: // Daytona refuses to stop a sandbox that is stopped already.
										Effect.flatMap(detail(id), (current) =>
											Option.isSome(current) &&
											stateOf(string(current.value, "state")) === "paused"
												? Effect.void
												: Effect.fail(
														failed(reply, "Stopping the Daytona sandbox"),
													),
										),
					),
				)

				return new Machine({
					shell,
					pausable: {
						pause: Effect.tap(stop, () => Ref.set(running, Option.none())),
						resume: Effect.asVoid(connect(true)),
					},
					...(desktop === undefined ? {} : { desktop }),
					ports: {
						open: (port: number) =>
							Effect.flatMap(ensure, () => signed(port, portSeconds)),
					},
					state: Effect.map(detail(id), (current) =>
						Option.isNone(current)
							? "gone"
							: stateOf(string(current.value, "state")),
					),
					destroy: destroy(id),
				})
			})

		return new Provider({ kind: "daytona", verify, create, attach })
	})
