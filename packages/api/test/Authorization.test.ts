import { assert, describe, it } from "@effect/vitest"
import { Condition, Policy } from "@nmnmcc/ability"
import type { Params } from "@nmnmcc/ability/HttpApi"
import {
	Array as Arr,
	Context,
	HashSet,
	Option,
	pipe,
	String as Str,
} from "effect"
import {
	HttpApi,
	type HttpApiEndpoint,
	type HttpApiGroup,
} from "effect/http-api"
import {
	GroupRequired,
	Required,
	type Requirement,
} from "../src/Authorization.ts"
import * as Authorization from "../src/Authorization.ts"
import { CapabilityRequestId } from "../src/CapabilityRequestId.ts"
import { ConnectionId } from "../src/ConnectionId.ts"
import { OpenBotApi } from "../src/OpenBotApi.ts"

interface Endpoint {
	readonly group: HttpApiGroup.Top
	readonly endpoint: HttpApiEndpoint.Top
}

const endpoints = (): ReadonlyArray<Endpoint> => {
	// `reflect` gives the endpoints only to a callback.
	const found: Array<Endpoint> = []
	HttpApi.reflect(OpenBotApi, {
		onGroup: () => {},
		onEndpoint: ({ group, endpoint }) => {
			found.push({ group, endpoint })
		},
	})
	return found
}

/** The names of the `:name` parts of a path. */
const pathParams = (path: string): ReadonlyArray<string> =>
	pipe(
		Str.split(path, "/"),
		Arr.filter(Str.startsWith(":")),
		Arr.map(Str.slice(1)),
	)

/** The requirements that the middleware checks, in the same way as it finds them. */
const requirementsOf = ({
	group,
	endpoint,
}: Endpoint): ReadonlyArray<Requirement> =>
	pipe(
		Context.getOption(endpoint.annotations, Required),
		Option.orElse(() =>
			Option.map(
				Context.getOption(group.annotations, GroupRequired),
				(rules) => (endpoint.method === "GET" ? rules.read : rules.write),
			),
		),
		Option.getOrElse((): ReadonlyArray<Requirement> => []),
	)

/** The path parameters that the scope of a requirement reads. */
const paramsRead = (requirement: Requirement): ReadonlyArray<string> => {
	if (requirement.within === undefined) return []
	// The proxy writes down each name that the scope reads.
	let read = HashSet.empty<string>()
	const params: Params = new Proxy(
		{},
		{
			get: (_, key) => {
				if (typeof key === "string") read = HashSet.add(read, key)
				return "value"
			},
		},
	)
	const scope = requirement.within(params) as (
		builder: Condition.Builder<unknown, unknown, unknown>,
	) => unknown
	scope(Condition.builder())
	return Arr.fromIterable(read)
}

const nameOf = ({ group, endpoint }: Endpoint) =>
	`${group.identifier}.${endpoint.identifier}`

describe("Authorization", () => {
	it("a requirement reads the path parameter of its endpoint", () => {
		const getChat = Arr.findFirst(
			endpoints(),
			(endpoint) => nameOf(endpoint) === "chats.getChat",
		)
		assert.isTrue(Option.isSome(getChat))
		if (Option.isNone(getChat)) return
		assert.deepStrictEqual(
			Arr.flatMap(requirementsOf(getChat.value), paramsRead),
			["chatId"],
		)
	})

	it("each requirement only reads path parameters that its endpoint has", () => {
		const problems = Arr.flatMap(endpoints(), (endpoint) => {
			const params = pathParams(endpoint.endpoint.path)
			return pipe(
				requirementsOf(endpoint),
				Arr.flatMap(paramsRead),
				Arr.filter((name) => !Arr.contains(params, name)),
				Arr.map(
					(name) =>
						`${nameOf(endpoint)} reads :${name}, but its path is ${endpoint.endpoint.path}`,
				),
			)
		})
		assert.deepStrictEqual(problems, [])
	})
})

describe("Authorization with branded IDs", () => {
	const principal = {
		kind: "member",
		organizationId: "org_a",
		userId: "user_a",
	} as const
	const member = Option.getOrThrow(
		Arr.findFirst(Authorization.builtinRoles, (role) => role.id === "member"),
	).policy
	const policies = [
		member,
		Policy.all([member, Authorization.defaultTokenPolicy]),
	]

	it("own connection rules cover lists and IDs but keep other owners out", () => {
		for (const policy of policies) {
			assert.strictEqual(
				Policy.coverage(policy, {
					principal,
					action: "write",
					kind: "Connection",
					within: ($) =>
						$.under(
							"org",
							$.principal("organizationId"),
							"user",
							$.principal("userId"),
						),
				})._tag,
				"All",
			)
			assert.strictEqual(
				Policy.coverage(policy, {
					principal,
					action: "read",
					kind: "Connection",
					within: ($) =>
						$.and(
							$.under(
								"org",
								$.principal("organizationId"),
								"user",
								$.principal("userId"),
							),
							$.eq("id", ConnectionId.make("connection_a")),
						),
				})._tag,
				"All",
			)
			assert.strictEqual(
				Policy.coverage(policy, {
					principal,
					action: "read",
					kind: "Connection",
					within: ($) => $.under("org", "org_a", "user", "user_b"),
				})._tag,
				"None",
			)
		}
	})

	it("a token rule still limits a connection by its ID", () => {
		const token = Policy.define(Authorization.OpenBot)(function* (_) {
			yield* _.allow("read", Authorization.Connection, {
				when: ($) => $.eq("id", ConnectionId.make("connection_a")),
			})
		})
		const policy = Policy.all([member, token])
		for (const [id, expected] of [
			["connection_a", "All"],
			["connection_b", "None"],
		] as const) {
			assert.strictEqual(
				Policy.coverage(policy, {
					principal,
					action: "read",
					kind: "Connection",
					within: ($) =>
						$.and(
							$.under(
								"org",
								$.principal("organizationId"),
								"user",
								$.principal("userId"),
							),
							$.eq("id", ConnectionId.make(id)),
						),
				})._tag,
				expected,
			)
		}
	})

	it("own request rules cover IDs but keep other organizations out", () => {
		for (const policy of policies) {
			assert.strictEqual(
				Policy.coverage(policy, {
					principal,
					action: "resolve",
					kind: "Request",
					within: ($) =>
						$.and(
							$.under(
								"org",
								$.principal("organizationId"),
								"user",
								$.principal("userId"),
							),
							$.eq("id", CapabilityRequestId.make("request_a")),
						),
				})._tag,
				"All",
			)
			assert.strictEqual(
				Policy.coverage(policy, {
					principal,
					action: "resolve",
					kind: "Request",
					within: ($) => $.under("org", "org_b", "user", "user_a"),
				})._tag,
				"None",
			)
		}
	})
})
