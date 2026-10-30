import { type Authorizer, Condition, type Domain } from "@nmnmcc/ability"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
import { Authorization, Account, Identity } from "@openbot-build/domain"
import type { Schema } from "effect"
import { CapabilityRequestIdBrand } from "./CapabilityRequestId.ts"
import { ConnectionIdBrand } from "./ConnectionId.ts"
import { HttpApiMiddleware } from "effect/http-api"
export {
	App,
	AuditLog,
	Auth,
	Bot,
	Budget,
	CeilingInput,
	CeilingSchema,
	Channel,
	ChannelIdentity,
	Chat,
	Computer,
	ComputerProvider,
	Connection,
	Decision,
	File,
	Forbidden,
	Kind,
	Member,
	Model,
	ModelProvider,
	OpenBot,
	Organization,
	Platform,
	PlatformAuth,
	PolicyInput,
	PolicySchema,
	PolicyUnavailable,
	Request,
	ResourceAction,
	ResourceInfo,
	Role,
	SecretProvider,
	Sso,
	Token,
	Trigger,
	Usage,
	Wallet,
	Vault,
	builtinRoles,
	defaultTokenPolicy,
	emptyPolicy,
	maxDepth,
	maxRules,
	onlyDenies,
	platform,
	resourceInfo,
} from "@openbot-build/domain/Authorization"
export type {
	OpenBotDomain,
	OpenBotPolicy,
	Policy,
} from "@openbot-build/domain/Authorization"
const { Auth, PlatformAuth } = Authorization
type OpenBot = Authorization.OpenBot

/**
 * The errors of a check: `Forbidden` (403) when the policy says no, and
 * `PolicyUnavailable` (503) when OpenBot can not load the policy.
 */
export interface ForbiddenError extends Authorizer.Forbidden {}
export interface PolicyUnavailableError extends Authorizer.PolicyUnavailable {}
export interface PendingError extends Authorizer.Pending {}
export const AuthorizationErrors: readonly [
	Schema.Codec<ForbiddenError, (typeof AbilityHttpApi.errors)[0]["Encoded"]>,
	Schema.Codec<
		PolicyUnavailableError,
		(typeof AbilityHttpApi.errors)[1]["Encoded"]
	>,
	Schema.Codec<PendingError, (typeof AbilityHttpApi.errors)[2]["Encoded"]>,
] = AbilityHttpApi.errors
/**
 * Checks the `Required` annotation of each endpoint, or the `GroupRequired`
 * annotation of its group, with the policy of the caller.
 * An endpoint without either annotation fails, so a new endpoint cannot be
 * open by mistake.
 * @effect-expect-leaking RouteContext
 */
export class Authorize extends HttpApiMiddleware.Service<
	Authorize,
	{ readonly requires: Identity }
>()("@openbot-build/api/Authorization/Authorize", {
	error: AuthorizationErrors,
}) {}

/** The same checks as {@link Authorize}, for the platform API. */
export class PlatformAuthorize extends HttpApiMiddleware.Service<
	PlatformAuthorize,
	{ readonly requires: Account }
>()("@openbot-build/api/Authorization/PlatformAuthorize", {
	error: AuthorizationErrors,
}) {}

export const Required = AbilityHttpApi.Required
export const GroupRequired = AbilityHttpApi.GroupRequired
export type Requirement = AbilityHttpApi.Requirement

type OwnKind =
	| "Chat"
	| "File"
	| "Request"
	| "Connection"
	| "App"
	| "Token"
	| "ChannelIdentity"
type OrganizationKind =
	| "Organization"
	| "Role"
	| "Member"
	| "ModelProvider"
	| "Sso"
	| "AuditLog"
	| "Usage"
	| "Wallet"
	| "Budget"

/**
 * A path parameter. A requirement must only name a parameter that its endpoint
 * has, and a test of the contract checks this. The empty string is only there
 * because a scope needs a string.
 */
const param = (
	params: Readonly<Record<string, string | undefined>>,
	name: string,
) => params[name] ?? ""

/** The kinds of the caller with an `id`, so that a path parameter can name one. */
type OwnIdKind = "Chat" | "File" | "Request" | "Connection"

/** The scope of every resource of the caller. */
const ofCaller = <K extends string>($: Condition.Builder<OpenBot, K>) =>
	$.under("org", $.principal("organizationId"), "user", $.principal("userId"))

/**
 * An act on the resources of the caller: the check passes when the caller may
 * act on every one of them. With `name`, the path parameter with that name
 * names one resource, and the check is on that one.
 */
export function own<const K extends OwnIdKind>(
	action: Domain.CommonAction<OpenBot, K>,
	kind: K,
	name: string,
): Requirement
export function own<const K extends OwnKind>(
	action: Domain.CommonAction<OpenBot, K>,
	kind: K,
): Requirement
export function own(action: string, kind: OwnKind, name?: string): Requirement {
	if (name === undefined) return { action, kind, within: () => ofCaller }
	return {
		action,
		kind,
		within: (params) => () => {
			const id = param(params, name)
			switch (kind) {
				case "Connection": {
					const $ = Condition.builder(Authorization.OpenBot, kind)
					return $.and(ofCaller($), $.eq("id", ConnectionIdBrand.make(id)))
				}
				case "Request": {
					const $ = Condition.builder(Authorization.OpenBot, kind)
					return $.and(
						ofCaller($),
						$.eq("id", CapabilityRequestIdBrand.make(id)),
					)
				}
				case "Chat":
				case "File": {
					const $ = Condition.builder(Authorization.OpenBot, kind)
					return $.and(ofCaller($), $.eq("id", id))
				}
				default:
					return ofCaller(Condition.builder(Authorization.OpenBot, kind))
			}
		},
	}
}

/** An act on the organization of the caller, such as reading its members. */
export const organization = <const K extends OrganizationKind>(
	action: Domain.CommonAction<OpenBot, K>,
	kind: K,
): Requirement =>
	AbilityHttpApi.requires(Auth, action, kind, {
		within: () => ($) => $.under("org", $.principal("organizationId")),
	})

/** An act on every Channel of the organization of the caller, such as making a new one. */
export const channels = (
	action: Domain.ActionOf<OpenBot, "Channel">,
): Requirement =>
	AbilityHttpApi.requires(Auth, action, "Channel", {
		within: () => ($) => $.under("org", $.principal("organizationId")),
	})

/** An act on one Channel, named by a path parameter. */
export const channel = (
	action: Domain.ActionOf<OpenBot, "Channel">,
	name: string,
): Requirement =>
	AbilityHttpApi.requires(Auth, action, "Channel", {
		within: (params) => ($) =>
			$.and(
				$.under("org", $.principal("organizationId")),
				$.eq("id", param(params, name)),
			),
	})

/** An act on the platform. */
export const onPlatform = (
	action: Domain.ActionOf<OpenBot, "Platform">,
): Requirement => AbilityHttpApi.requires(PlatformAuth, action, "Platform")
