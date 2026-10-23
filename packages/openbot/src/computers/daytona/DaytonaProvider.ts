// `make` builds a Provider from its secrets. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
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
import type { ComputersApi } from "@openbot-build/api"
import { Clock, Effect, Option, Ref, Result } from "effect"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	ComputerCallFailed,
	ComputerGone,
	Machine,
	type MachineState,
	Provider,
	type Spec,
} from "../Computer.ts"
import {
	appendTail,
	emptyTail,
	failed,
	field,
	json,
	number,
	ok,
	outputLimit,
	pngSize,
	quote,
	type Reply,
	send,
	string,
	tailText,
	text,
} from "../Http.ts"

export type Credentials = Extract<
	ComputersApi.ComputerProviderCredentials,
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

const gone = (id: string) =>
	new ComputerGone({ reason: `The Daytona sandbox ${id} does not exist` })

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

const marker = () =>
	`__OPENBOT_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}__`

/**
 * The toolbox gives stdout and stderr together and has no clear form for a timeout.
 * So OpenBot wraps the command: `timeout` stops it, stderr goes to a file, and the
 * script prints a marker, the exit code and then stderr after the command.
 */
export const wrap = (
	request: ComputersApi.RunCommandRequest,
	mark: string,
	seconds: number,
) =>
	`bash -c ${quote(
		[
			"__e=$(mktemp)",
			`timeout -k 5 ${seconds} bash -lc ${quote(request.command)} 2>"$__e"`,
			"__c=$?",
			`printf '\\n${mark}%s\\n' "$__c"`,
			'cat "$__e"',
			'rm -f "$__e"',
		].join("\n"),
	)}`

/** `timeout` exits with 124 when it stops the command, and 137 when it must kill it. */
const timedOutCodes = [124, 137]

export const unwrap = (result: string, mark: string) => {
	const at = result.lastIndexOf(`\n${mark}`)
	if (at < 0) return { stdout: result, stderr: "", exitCode: undefined }
	const rest = result.slice(at + mark.length + 1)
	const newline = rest.indexOf("\n")
	const code = Number(newline < 0 ? rest : rest.slice(0, newline))
	return {
		stdout: result.slice(0, at),
		stderr: newline < 0 ? "" : rest.slice(newline + 1),
		exitCode: Number.isInteger(code) ? code : undefined,
	}
}

/** Keeps the end of the text when it is longer than the limit. */
const tail = (value: string) =>
	appendTail(emptyTail, new TextEncoder().encode(value), outputLimit)

const entry = (value: unknown): ComputersApi.FileEntry => {
	const modified = string(value, "modTime") ?? string(value, "modifiedAt")
	const parsed = modified === undefined ? Number.NaN : Date.parse(modified)
	return {
		name: string(value, "name") ?? "",
		// The mode is the text of a Go file mode, such as `Lrwxrwxrwx` for a link.
		kind: (string(value, "mode") ?? "").startsWith("L")
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
		const client = yield* HttpClient.HttpClient
		const api = `${credentials.apiUrl ?? defaultApiUrl}/api`
		const auth = {
			authorization: `Bearer ${credentials.apiKey}`,
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
			(what: string) =>
			(reply: Reply): Effect.Effect<Reply, ComputerCallFailed> =>
				ok(reply) ? Effect.succeed(reply) : Effect.fail(failed(reply, what))

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
							return `${proxy.replace(/\/$/, "")}/${id}`
						const reply = yield* call(
							HttpClientRequest.get(sandboxUrl(id, "/toolbox-proxy-url")),
						).pipe(
							Effect.flatMap(expect("Reading the Daytona toolbox address")),
						)
						const url = string(json(reply), "url") ?? ""
						return `${url.replace(/\/$/, "")}/${id}`
					})

				const start = call(
					HttpClientRequest.post(sandboxUrl(id, "/start")),
					startTimeoutMs,
				).pipe(Effect.flatMap(expect("Starting the Daytona sandbox")))

				/**
				 * Makes sure that the sandbox runs, and gives its toolbox address. It starts a
				 * stopped or archived sandbox and waits while Daytona starts it.
				 */
				const ensure: Effect.Effect<string, ComputerCallFailed | ComputerGone> =
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
								yield* start
								started = true
							}
							yield* Effect.sleep(1000)
						}
						return yield* new ComputerCallFailed({
							message: "The Daytona sandbox did not start in time",
							retry: true,
						})
					})

				const toolbox = (
					build: (base: string) => HttpClientRequest.HttpClientRequest,
					what: string,
					timeoutMs = controlTimeoutMs,
				) =>
					Effect.flatMap(ensure, (base) =>
						call(build(base), timeoutMs).pipe(Effect.flatMap(expect(what))),
					)

				const run = (request: ComputersApi.RunCommandRequest) =>
					Effect.gen(function* () {
						const seconds = request.timeout ?? 60
						const mark = marker()
						const startedAt = yield* Clock.currentTimeMillis
						const reply = yield* toolbox(
							(base) =>
								HttpClientRequest.post(`${base}/process/execute`).pipe(
									HttpClientRequest.bodyJsonUnsafe({
										command: wrap(request, mark, seconds),
										...(request.cwd === undefined ? {} : { cwd: request.cwd }),
										...(request.env === undefined ? {} : { envs: request.env }),
										// The wrapper stops the command first. This limit is only a safety net.
										timeout: seconds + 30,
									}),
								),
							"Running the command",
							(seconds + 60) * 1000,
						)
						const body = json(reply)
						const parts = unwrap(string(body, "result") ?? "", mark)
						const exitCode = parts.exitCode ?? number(body, "exitCode") ?? null
						const stdout = tail(parts.stdout)
						const stderr = tail(parts.stderr)
						return {
							exitCode:
								exitCode !== null && timedOutCodes.includes(exitCode)
									? null
									: exitCode,
							stdout: tailText(stdout),
							stderr: tailText(stderr),
							truncated: stdout.truncated || stderr.truncated,
							durationMs: (yield* Clock.currentTimeMillis) - startedAt,
						} satisfies ComputersApi.CommandResult
					})

				const query = (
					base: string,
					path: string,
					params: Record<string, string>,
				) => `${base}${path}?${new URLSearchParams(params)}`

				const shell = {
					run,
					read: (path: string, encoding: ComputersApi.FileEncoding) =>
						toolbox(
							(base) =>
								HttpClientRequest.get(query(base, "/files/download", { path })),
							`Reading ${path}`,
						).pipe(
							Effect.map((reply): ComputersApi.FileContent => ({
								path,
								encoding,
								content:
									encoding === "base64"
										? Base64.encode(reply.body)
										: text(reply),
							})),
						),
					write: (file: ComputersApi.FileContent) =>
						Effect.gen(function* () {
							const bytes =
								file.encoding === "base64"
									? yield* Base64.decode(file.content).pipe(
											Effect.fromResult,
											Effect.mapError(
												() =>
													new ComputerCallFailed({
														message: "The file content is not valid base64",
														retry: false,
													}),
											),
										)
									: new TextEncoder().encode(file.content)
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
						).pipe(
							Effect.map((reply) => {
								const entries = json(reply)
								return Array.isArray(entries) ? entries.map(entry) : []
							}),
						),
					remove: (path: string) =>
						toolbox(
							(base) =>
								HttpClientRequest.delete(
									query(base, "/files", { path, recursive: "true" }),
								),
							`Removing ${path}`,
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
						Effect.map((reply) =>
							(string(json(reply), "url") ?? "").replace(/\/$/, ""),
						),
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

				const action = (step: ComputersApi.DesktopAction) => {
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
										{ keys: step.keys.join("+") },
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
											Base64.decode(data.slice(0, 64)),
											() => new Uint8Array(0),
										),
									)
									if (size === undefined)
										return yield* new ComputerCallFailed({
											message: "The screenshot of Daytona is not a PNG image",
											retry: true,
										})
									return {
										mediaType: "image/png",
										data,
										...size,
									} satisfies ComputersApi.Screenshot
								}),
								act: (actions: ReadonlyArray<ComputersApi.DesktopAction>) =>
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
									} satisfies ComputersApi.DesktopStream
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
						resume: Effect.asVoid(ensure),
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
