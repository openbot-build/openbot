import { AuthApi } from "@openbot-build/api"
import { Array as Arr, Effect, Option, Redacted, Schema } from "effect"
import {
	type HttpBody,
	HttpClient,
	type HttpClientError,
	HttpClientRequest,
	type HttpClientResponse,
	type HttpMethod,
} from "effect/http"

/**
 * One call to the API and its answer. A payload that cannot become JSON fails
 * with `HttpBodyError`. Give it an `HttpClient`, such as `FetchHttpClient.layer`.
 */
export type Call = Effect.Effect<
	HttpClientResponse.HttpClientResponse,
	HttpClientError.HttpClientError | HttpBody.HttpBodyError,
	HttpClient.HttpClient
>

/** The API gave a status that the test did not expect. */
export class UnexpectedStatus extends Schema.TaggedError<
	UnexpectedStatus,
	{ readonly brand: unique symbol }
>()("UnexpectedStatus", { status: Schema.Int, body: Schema.String }) {
	override get message() {
		return this.status + " " + this.body
	}
}

/** The account of a session has no organization. */
export class NoOrganization extends Schema.TaggedError<
	NoOrganization,
	{ readonly brand: unique symbol }
>()("NoOrganization", { userId: Schema.String }) {
	override get message() {
		return "The account has no organization"
	}
}

/** Sends a request, with the payload as its JSON body when there is one. */
const send = (
	request: HttpClientRequest.HttpClientRequest,
	payload: unknown,
): Call =>
	(payload === undefined
		? Effect.succeed(request)
		: HttpClientRequest.bodyJson(request, payload)
	).pipe(Effect.flatMap(HttpClient.execute))

/** The cookie header of a signed-in browser session. */
export const sessionCookie = (credential: Redacted.Redacted<string>) =>
	AuthApi.SessionCookie + "=" + encodeURIComponent(Redacted.value(credential))

/** Call the API as a signed-in browser on the public origin. */
export const withCookie =
	({
		address,
		publicOrigin,
	}: {
		readonly address: string
		readonly publicOrigin: string
	}) =>
	(
		credential: Redacted.Redacted<string>,
		path: string,
		method: HttpMethod.HttpMethod = "GET",
		payload?: unknown,
	): Call =>
		send(
			HttpClientRequest.make(method)(address + path, {
				headers: {
					cookie: sessionCookie(credential),
					origin: publicOrigin,
				},
			}),
			payload,
		)

/** Call the API as a program with a user token. */
export const withToken =
	(address: string) =>
	(
		secret: string,
		path: string,
		method: HttpMethod.HttpMethod = "GET",
		payload?: unknown,
	): Call =>
		send(
			HttpClientRequest.make(method)(address + path).pipe(
				HttpClientRequest.bearerToken(secret),
			),
			payload,
		)

/**
 * Reads the JSON body of an answer with a schema. It fails with
 * `UnexpectedStatus` when the status is not `status`, or not 2xx when no
 * status is given. The server writes the JSON form of the schema
 * (`Schema.toCodecJson`), where an optional value that is not there is null,
 * so the body is read with that form too.
 */
export const json =
	<S extends Schema.Constraint>(schema: S, status?: number) =>
	(response: HttpClientResponse.HttpClientResponse) =>
		Effect.gen(function* () {
			const body = yield* response.text
			const expected =
				status === undefined
					? response.status >= 200 && response.status < 300
					: response.status === status
			if (!expected)
				return yield* UnexpectedStatus.make({ status: response.status, body })
			return yield* Schema.decodeEffect(
				Schema.fromJsonString(Schema.toCodecJson(schema)),
			)(body)
		})

/** Sends a call and reads its JSON answer with a schema, as `json` does. */
export const read = <S extends Schema.Constraint>(
	schema: S,
	call: Call,
	status?: number,
) => Effect.flatMap(call, json(schema, status))

/** The member of the first organization of a signed-in account. */
export const memberOf = (session: {
	readonly userId: string
	readonly memberships: ReadonlyArray<{ readonly organizationId: string }>
}) =>
	Option.match(Arr.head(session.memberships), {
		onNone: () => Effect.fail(NoOrganization.make({ userId: session.userId })),
		onSome: (first) =>
			Effect.succeed({
				userId: session.userId,
				organizationId: first.organizationId,
			}),
	})
