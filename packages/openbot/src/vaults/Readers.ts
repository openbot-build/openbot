import { Redacted } from "effect"
import type { VaultsApi } from "@openbot-build/api"
import {
	Array as Arr,
	Context,
	Effect,
	HashMap,
	Option,
	Layer,
	pipe,
	Predicate,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

/**
 * The secret provider did not answer, refused the token, or has no such item or field.
 * Callers show the message. The cause stays inside OpenBot.
 */
export class VaultReadFailed extends Schema.TaggedError<
	VaultReadFailed,
	{ readonly brand: unique symbol }
>()("VaultReadFailed", {
	message: Schema.String,
	retry: Schema.Boolean,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** The credentials of a secret provider. */
export type Remote = VaultsApi.SecretProviderCredentials

/** Reads one secret provider. It never writes to it. */
export interface Reader {
	/** Checks the address and the token. */
	readonly verify: Effect.Effect<void, VaultReadFailed>
	/** The values of these fields of one item. It fails when a field is missing. */
	readonly read: (
		source: VaultsApi.VaultItemSource,
		fields: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyMap<string, string>, VaultReadFailed>
}

/** Builds the reader of a secret provider from its secrets. Tests give their own. */
export class Readers extends Context.Service<
	Readers,
	{ readonly make: (credentials: Remote) => Reader }
>()("@openbot-build/openbot/vaults/Readers") {}

const timeoutMs = 15_000
const decoder = new TextDecoder()
const decodeJson = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Unknown),
)

const failed = (message: string, cause?: unknown, retry = false) =>
	VaultReadFailed.make({ message, cause, retry })

/** Sends one request and gives back the JSON body of a good answer. */
const fetchJson = (
	client: HttpClient.HttpClient,
	request: HttpClientRequest.HttpClientRequest,
	what: string,
): Effect.Effect<unknown, VaultReadFailed> =>
	client.execute(request).pipe(
		Effect.flatMap((response) =>
			Effect.map(response.arrayBuffer, (buffer) => ({
				status: response.status,
				text: decoder.decode(buffer),
			})),
		),
		Effect.mapError((error) =>
			failed(`${what}: the password manager did not answer`, error, true),
		),
		Effect.timeoutOrElse({
			duration: timeoutMs,
			orElse: () =>
				Effect.fail(
					failed(
						`${what}: the password manager did not answer in time`,
						undefined,
						true,
					),
				),
		}),
		Effect.flatMap(({ status, text }) => {
			if (status === 401 || status === 403)
				return Effect.fail(
					failed(`${what}: the password manager did not take the token`),
				)
			if (status === 404)
				return Effect.fail(
					failed(`${what}: the password manager has no such item`),
				)
			if (status < 200 || status >= 300)
				return Effect.fail(
					failed(
						`${what} failed with HTTP ${status}`,
						undefined,
						status === 429 || status >= 500,
					),
				)
			return decodeJson(text).pipe(
				// @effect-rules-next-line blind-error-map -- The answer can hold secrets, and the decode failure holds the answer, so the error must not keep it.
				Effect.mapError(() => failed(`${what}: the answer is not JSON`)),
			)
		}),
	)

const field = (value: unknown, key: string): unknown =>
	Predicate.isObject(value)
		? (value as Record<string, unknown>)[key]
		: undefined
const list = (value: unknown): ReadonlyArray<unknown> =>
	Arr.isArray(value) ? value : []
const string = (value: unknown): string | undefined =>
	Predicate.isString(value) ? value : undefined

/** Takes the asked fields from all fields of an item. */
const pick = (
	found: HashMap.HashMap<string, string>,
	fields: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, string>, VaultReadFailed> => {
	const missing = Arr.filter(fields, (name) => !HashMap.has(found, name))
	if (missing.length > 0)
		return Effect.fail(
			failed(`The item has no field with the name ${Arr.join(missing, ", ")}`),
		)
	return Effect.succeed(
		new Map(
			Arr.flatMap(fields, (name) =>
				Option.toArray(
					Option.map(
						HashMap.get(found, name),
						(value) => [name, value] as const,
					),
				),
			),
		),
	)
}

const wrongSource = (kind: string) =>
	Effect.fail(failed(`The source of the item is not for a ${kind} Vault`))

/**
 * 1Password Connect. A field is found by its label or its ID. The username and the
 * password of a login are also found as `username` and `password`.
 */
export const onePassword = (
	client: HttpClient.HttpClient,
	credentials: Extract<Remote, { readonly kind: "onepassword" }>,
): Reader => {
	const get = (path: string, what: string) =>
		fetchJson(
			client,
			HttpClientRequest.get(credentials.url + path).pipe(
				HttpClientRequest.bearerToken(credentials.token),
			),
			what,
		)
	return {
		verify: get("/v1/vaults", "Listing the 1Password vaults").pipe(
			Effect.asVoid,
		),
		read: (source, fields) => {
			if (source._tag !== "OnePassword") return wrongSource("1Password")
			return get(
				`/v1/vaults/${encodeURIComponent(source.vault)}/items/${encodeURIComponent(source.item)}`,
				"Reading the 1Password item",
			).pipe(
				Effect.flatMap((item) => {
					let found = HashMap.empty<string, string>()
					for (const entry of list(field(item, "fields"))) {
						const value = string(field(entry, "value"))
						if (value === undefined) continue
						const purpose = string(field(entry, "purpose"))
						if (purpose === "USERNAME")
							found = HashMap.set(found, "username", value)
						if (purpose === "PASSWORD")
							found = HashMap.set(found, "password", value)
						const id = string(field(entry, "id"))
						if (id !== undefined && !HashMap.has(found, id))
							found = HashMap.set(found, id, value)
						const label = string(field(entry, "label"))
						if (label !== undefined) found = HashMap.set(found, label, value)
					}
					return pick(found, fields)
				}),
			)
		},
	}
}

/**
 * The API of `bw serve`. `username`, `password`, `notes` and custom fields come from the item.
 * `totp` is the current one-time code, not the seed.
 */
export const bitwarden = (
	client: HttpClient.HttpClient,
	credentials: Extract<Remote, { readonly kind: "bitwarden" }>,
): Reader => {
	const get = (path: string, what: string) =>
		fetchJson(
			client,
			HttpClientRequest.get(credentials.url + path).pipe(
				credentials.token === undefined
					? (request) => request
					: HttpClientRequest.bearerToken(credentials.token),
			),
			what,
		).pipe(
			Effect.flatMap((body) => {
				if (field(body, "success") === true)
					return Effect.succeed(field(body, "data"))
				const message = string(field(body, "message"))
				return Effect.fail(
					failed(
						`${what}: ${message === undefined ? "Bitwarden said no" : Str.slice(0, 200)(message)}`,
					),
				)
			}),
		)
	return {
		verify: get("/status", "Reading the Bitwarden status").pipe(
			Effect.flatMap((data) =>
				string(field(field(data, "template"), "status")) === "unlocked"
					? Effect.void
					: Effect.fail(
							failed(
								"The Bitwarden vault is locked. Unlock it for `bw serve`.",
							),
						),
			),
		),
		read: (source, fields) => {
			if (source._tag !== "Bitwarden") return wrongSource("Bitwarden")
			const id = encodeURIComponent(source.item)
			return Effect.gen(function* () {
				const item = yield* get(
					`/object/item/${id}`,
					"Reading the Bitwarden item",
				)
				let found = HashMap.empty<string, string>()
				const login = field(item, "login")
				for (const key of ["username", "password"] as const) {
					const value = string(field(login, key))
					if (value !== undefined) found = HashMap.set(found, key, value)
				}
				const notes = string(field(item, "notes"))
				if (notes !== undefined) found = HashMap.set(found, "notes", notes)
				for (const entry of list(field(item, "fields"))) {
					const name = string(field(entry, "name"))
					const value = string(field(entry, "value"))
					if (name !== undefined && value !== undefined)
						found = HashMap.set(found, name, value)
				}
				if (fields.includes("totp") && !HashMap.has(found, "totp")) {
					const code = string(
						field(
							yield* get(`/object/totp/${id}`, "Reading the Bitwarden code"),
							"data",
						),
					)
					if (code !== undefined) found = HashMap.set(found, "totp", code)
				}
				return yield* pick(found, fields)
			})
		},
	}
}

/** The KV version 2 engine of HashiCorp Vault or OpenBao. Each key of the secret is a field. */
export const hashiCorp = (
	client: HttpClient.HttpClient,
	credentials: Extract<Remote, { readonly kind: "hashicorp" }>,
): Reader => {
	const mount = Str.replace(/^\/+|\/+$/g, "")(credentials.mount ?? "secret")
	const get = (path: string, what: string) =>
		fetchJson(
			client,
			HttpClientRequest.get(credentials.url + path).pipe(
				HttpClientRequest.setHeader(
					"X-Vault-Token",
					Redacted.value(credentials.token),
				),
				credentials.namespace === undefined
					? (request) => request
					: HttpClientRequest.setHeader(
							"X-Vault-Namespace",
							credentials.namespace,
						),
			),
			what,
		)
	return {
		verify: get("/v1/auth/token/lookup-self", "Checking the Vault token").pipe(
			Effect.asVoid,
		),
		read: (source, fields) => {
			if (source._tag !== "HashiCorp") return wrongSource("HashiCorp")
			const path = pipe(
				source.path,
				Str.replace(/^\/+|\/+$/g, ""),
				Str.split("/"),
				Arr.map((part) => encodeURIComponent(part)),
				Arr.join("/"),
			)
			return get(`/v1/${mount}/data/${path}`, "Reading the Vault secret").pipe(
				Effect.flatMap((body) => {
					const data = field(field(body, "data"), "data")
					let found = HashMap.empty<string, string>()
					if (Predicate.isObject(data))
						for (const [key, value] of Rec.toEntries(data))
							found = HashMap.set(
								found,
								key,
								Predicate.isString(value) ? value : JSON.stringify(value),
							)
					return pick(found, fields)
				}),
			)
		},
	}
}

export const layer = Layer.effect(
	Readers,
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		return Readers.of({
			make: (credentials) => {
				switch (credentials.kind) {
					case "onepassword":
						return onePassword(client, credentials)
					case "bitwarden":
						return bitwarden(client, credentials)
					case "hashicorp":
						return hashiCorp(client, credentials)
				}
			},
		})
	}),
)
