import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import * as Access from "@openbot-build/domain/Access"
import { AccountAuth, NoStore, OriginCheck } from "./AuthApi.ts"
import {
	GroupRequired,
	onPlatform,
	PlatformAuthorize,
} from "./Authorization.ts"
export {
	AdmissionMode,
	GroupMapping,
	ProviderAccess,
	Registration,
	providerDefaults,
	defaults,
	AccountStatus,
	User,
	Request,
	Grant,
	Event,
	LoginOptions,
	AccessDenied,
	AccessConflict,
	AccessUnavailable,
} from "@openbot-build/domain/Access"
const errors = [
	Access.AccessDenied.pipe(HttpApiSchema.status(403)),
	Access.AccessUnavailable.pipe(HttpApiSchema.status(503)),
	Access.AccessConflict.pipe(HttpApiSchema.status(409)),
]
const page = {
	after: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
}
export class AccessApi extends HttpApiGroup.make("access")
	.add(
		HttpApiEndpoint.get("users", "/v1/platform/users", {
			query: page,
			success: Schema.Struct({
				items: Schema.Array(Access.User),
				next: Schema.NullOr(Schema.String),
			}),
			error: errors,
		}),
		HttpApiEndpoint.patch("updateUser", "/v1/platform/users/:userId", {
			params: { userId: Schema.String },
			payload: Schema.Struct({ status: Access.AccountStatus }),
			success: HttpApiSchema.NoContent,
			error: errors,
		}),
		HttpApiEndpoint.get("requests", "/v1/platform/registration_requests", {
			query: page,
			success: Schema.Struct({
				items: Schema.Array(Access.Request),
				next: Schema.NullOr(Schema.String),
			}),
			error: errors,
		}),
		HttpApiEndpoint.patch(
			"decide",
			"/v1/platform/registration_requests/:requestId",
			{
				params: { requestId: Schema.String },
				payload: Schema.Struct({
					expectedVersion: Schema.Int,
					status: Schema.Literals(["approved", "rejected"]),
				}),
				success: HttpApiSchema.NoContent,
				error: errors,
			},
		),
		HttpApiEndpoint.get("grants", "/v1/platform/user_grants", {
			query: page,
			success: Schema.Struct({
				items: Schema.Array(Access.Grant),
				next: Schema.NullOr(Schema.String),
			}),
			error: errors,
		}),
		HttpApiEndpoint.post("grant", "/v1/platform/user_grants", {
			payload: Schema.Struct({
				email: Access.Grant.fields.email,
				providerId: Schema.NonEmptyString,
			}),
			success: HttpApiSchema.NoContent,
			error: errors,
		}),
		HttpApiEndpoint.delete("revokeGrant", "/v1/platform/user_grants", {
			payload: Schema.Struct({
				email: Access.Grant.fields.email,
				providerId: Schema.NonEmptyString,
			}),
			success: HttpApiSchema.NoContent,
			error: errors,
		}),
		HttpApiEndpoint.get("audit", "/v1/platform/access_events", {
			query: page,
			success: Schema.Struct({
				items: Schema.Array(Access.Event),
				next: Schema.NullOr(Schema.String),
			}),
			error: errors,
		}),
	)
	.annotate(GroupRequired, {
		read: [onPlatform("read")],
		write: [onPlatform("write")],
	})
	.middleware(PlatformAuthorize)
	.middleware(AccountAuth)
	.middleware(NoStore) {}
export class LoginOptionsApi extends HttpApiGroup.make("loginOptions")
	.add(
		HttpApiEndpoint.get("get", "/auth/options", {
			success: Access.LoginOptions,
			error: errors,
		}),
	)
	.middleware(NoStore) {}

export class EmailSignInApi extends HttpApiGroup.make("emailSignIn")
	.add(
		HttpApiEndpoint.post("send", "/auth/email/send", {
			payload: Schema.Struct({
				email: Access.Grant.fields.email,
				invitation: Schema.optionalKey(Schema.NonEmptyString),
			}),
			success: Schema.Struct({ challenge: Schema.String }),
			error: errors,
		}),
		HttpApiEndpoint.post("verify", "/auth/email/verify", {
			payload: Schema.Struct({
				challenge: Schema.String.check(Schema.isMaxLength(4096)),
				code: Schema.String.check(Schema.isPattern(/^\d{8}$/)),
			}),
			success: HttpApiSchema.NoContent,
			error: errors,
		}),
	)
	.middleware(OriginCheck)
	.middleware(NoStore) {}
