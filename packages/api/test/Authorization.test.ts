import { assert, describe, it } from "@effect/vitest"
import { Condition } from "@nmnmcc/ability"
import type { Params } from "@nmnmcc/ability/HttpApi"
import { Array as Arr, Context, Option, pipe, String as Str } from "effect"
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
	const read = new Set<string>()
	const params: Params = new Proxy(
		{},
		{
			get: (_, key) => {
				if (typeof key === "string") read.add(key)
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
