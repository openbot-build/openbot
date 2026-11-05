/**
 * Checks the Effect rules of OpenBot that the Effect language service does not
 * check. `pnpm typecheck` runs this script. The "Effect rules" part of the
 * contributing docs gives the rules and the reasons for them.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Acorn from "acorn"
import {
	Array as Arr,
	Console,
	Effect,
	Equal,
	FileSystem,
	HashSet,
	Option,
	Path,
	pipe,
	type PlatformError,
	Predicate,
	Record as Rec,
	Result,
	Schema,
	String as Str,
} from "effect"
import { stripTypeScriptTypes } from "node:module"
import * as ServiceContracts from "./service-contracts.ts"

/** The folders with the TypeScript code that the rules cover. */
const roots = ["packages", "protocol-test", "scripts"] as const
/** Parts of a path that hold no hand-written Effect code. */
const skipped = ["node_modules", "dist", ".cache", "docs"] as const

const rules = {
	"service-contract":
		"Write the service type before its implementation. Do not take its shape from a constructor.",
	"directive-reason":
		"Give the reason after ` -- `, in a few words, for each `@effect-diagnostics` and `@effect-rules` comment.",
	"blind-error-map":
		"This maps every failure to a new error and drops the old one. Name the error and keep it as the cause, log it, or map only the failures you mean with `catchTag`.",
	"run-outside-main":
		"Only a program entry point (a `*Main.ts` file) runs an Effect. Everywhere else, return the Effect. Use a scoped `FiberSet` runtime for an outside callback.",
	throw:
		"Do not throw. Fail with a typed error, or use `Effect.die` for a broken rule of the code. In a test, use `assert.fail`.",
	"fork-daemon":
		"Do not fork a fiber with no owner. Fork it in a scope (`Effect.forkScoped`, `Effect.forkIn`) or keep it in a `FiberSet` / `FiberMap`.",
	"promise-then":
		"Do not chain Promises with `.then`. Turn the Promise into an Effect with `Effect.tryPromise` and go on in Effect.",
	"domain-boundary":
		"The domain may use core types and pure rules, but not transport, storage, or execution services.",
	"storage-contract-boundary":
		"Business code and storage use domain models. Only HTTP adapters and application assembly use HTTP contracts.",
	"standalone-boundary":
		"Core and protocol must work without the OpenBot product packages.",
	"execution-boundary":
		"Server work uses the common execution engine. Features must not build local Chat runtimes, another cluster, or a private RPC transport.",
	"public-entry":
		"Use the public entry of another package, not its source files. An entry of a server package must be a key of `exports` in its package.json.",
	"package-layer":
		"A package may import only packages of a lower layer. The order of the layers is on the architecture checks page of the docs. The database package uses only core and domain. Put shared types and service tags in a contract package (a `*-contract` package).",
	"kernel-provide":
		"A plugin must not publish a service of the kernel, so a plugin that is off cannot take away billing, limits, or other shared rules. Publish only keys of a contract package (a `*-contract` package), of api, domain, or protocol, or of the plugin itself.",
	"host-only":
		"Only the host serves HTTP. Do not call `HttpRouter.serve`, `HttpRouter.toWebHandler` or `HttpApiBuilder.layer`, add a global HTTP middleware, or make a layer from a workflow here. A plugin mounts its routes with `HttpHost` and gives its workflows with `Workflows.contribute`.",
	"graft-boundary":
		"Only the plugin kit (the `server-plugin` package), the `src/index.ts` file of a plugin package, the host (`packages/openbot/src`), the development server and the tests of OpenBot may import graft. Import graft's `Plugin` as `GraftPlugin`, so it is not mixed up with an OpenBot plugin.",
	"plugin-boundary":
		"A plugin must not import another plugin, in its code or in its tests. Put shared service tags and types in a contract package. The host connects the plugins through graft.",
	"plugin-entry":
		"The `src/index.ts` file of a plugin package has one export only: the plugin, as the default export. Keep other code in other modules.",
	"feature-lookup":
		"Do not look for a feature with `Effect.serviceOption` or `Plugin.optional`. List the services that the code needs, so the layer or the plugin asks for them.",
	parse: "The rules could not read this file.",
} as const

type Rule = keyof typeof rules

interface Finding {
	readonly file: string
	readonly line: number
	readonly rule: Rule
	/** More about this place, for example why the file could not be read. */
	readonly detail?: string
}

class EffectRulesFailed extends Schema.TaggedError<
	EffectRulesFailed,
	{ readonly brand: unique symbol }
>()("EffectRulesFailed", { message: Schema.String }) {}

type Node = Acorn.AnyNode

const isNode = (value: unknown): value is Node =>
	Predicate.hasProperty(value, "type") && Predicate.isString(value.type)

const children = (node: Node): ReadonlyArray<Node> => {
	const fields: unknown = node
	return Predicate.isObject(fields)
		? Arr.flatMap(Rec.values(fields), (value) =>
				Arr.isArray(value)
					? Arr.filter(value, isNode)
					: isNode(value)
						? [value]
						: [],
			)
		: []
}

const propertyName = (node: Node): Option.Option<string> =>
	node.type === "MemberExpression" && node.property.type === "Identifier"
		? Option.some(node.property.name)
		: Option.none()

/** A handler that cannot see the error: it has no parameter, or one named `_...`. */
const ignoresError = (node: Node): boolean =>
	(node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionExpression" ||
		node.type === "FunctionDeclaration") &&
	Option.match(Arr.head(node.params), {
		onNone: () => true,
		onSome: (first) =>
			first.type === "Identifier" && Str.startsWith("_")(first.name),
	})

const descendants = (node: Node): ReadonlyArray<Node> => [
	node,
	...Arr.flatMap(children(node), descendants),
]

/**
 * The names in a file that are only declared as handlers that cannot see the
 * error. A name with any other declaration in the file (a value, an import or
 * a parameter) is not in the result, because a use of it can mean that one.
 */
const blindNames = (program: Node): HashSet.HashSet<string> => {
	const parameters = (
		params: ReadonlyArray<Acorn.Pattern>,
	): ReadonlyArray<readonly [string, boolean]> =>
		Arr.flatMap(params, (param) =>
			param.type === "Identifier" ? [[param.name, false] as const] : [],
		)
	return pipe(
		descendants(program),
		Arr.flatMap((node): ReadonlyArray<readonly [string, boolean]> => {
			switch (node.type) {
				case "VariableDeclarator":
					return node.id.type === "Identifier"
						? [
								[
									node.id.name,
									Predicate.isNotNullish(node.init) && ignoresError(node.init),
								],
							]
						: []
				case "FunctionDeclaration":
					return [
						// An `export default function` can have no name.
						...(node.id === null
							? []
							: [[node.id.name, ignoresError(node)] as const]),
						...parameters(node.params),
					]
				case "ArrowFunctionExpression":
				case "FunctionExpression":
					return parameters(node.params)
				case "ImportSpecifier":
				case "ImportDefaultSpecifier":
				case "ImportNamespaceSpecifier":
					return [[node.local.name, false]]
				default:
					return []
			}
		}),
		Arr.groupBy(([name]) => name),
		Rec.filter((declarations) => Arr.every(declarations, ([, blind]) => blind)),
		Rec.keys,
		HashSet.fromIterable,
	)
}

/** A handler that cannot see the error, written in place or given by the name of such a function in the same file. */
const isBlind =
	(named: HashSet.HashSet<string>) =>
	(handler: Node): boolean =>
		ignoresError(handler) ||
		(handler.type === "Identifier" && HashSet.has(named, handler.name))

const runs = [
	"runPromise",
	"runPromiseExit",
	"runSync",
	"runSyncExit",
	"runFork",
	"runForkWith",
	"runCallback",
]

/** Core imports retain their names through aliases and package subpaths. */
const coreImports = (
	program: Node,
): Readonly<Record<string, ReadonlyArray<string>>> =>
	Rec.fromEntries(
		Arr.flatMap(
			descendants(program),
			(node): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
				if (node.type !== "ImportDeclaration") return []
				const source = node.source.value
				if (
					typeof source !== "string" ||
					!/^@openbot-build\/core(?:\/|$)/.test(source)
				)
					return []
				const prefix =
					source === "@openbot-build/core"
						? []
						: Arr.drop(Str.split(source, "/"), 2)
				return Arr.map(
					node.specifiers,
					(specifier) =>
						[
							specifier.local.name,
							specifier.type === "ImportSpecifier"
								? [
										...prefix,
										String(
											specifier.imported.type === "Identifier"
												? specifier.imported.name
												: specifier.imported.value,
										),
									]
								: prefix,
						] as const,
				)
			},
		),
	)

const memberParts = (node: Node): ReadonlyArray<string> => {
	if (node.type === "Identifier") return [node.name]
	if (node.type !== "MemberExpression") return []
	const key =
		!node.computed && node.property.type === "Identifier"
			? node.property.name
			: node.computed &&
				  node.property.type === "Literal" &&
				  typeof node.property.value === "string"
				? node.property.value
				: undefined
	return key === undefined ? [] : [...memberParts(node.object), key]
}

/**
 * These files read a value of the current request, such as the context window
 * of a model call. They do not look for a feature.
 */
const lookupFiles = [
	"packages/model-providers/src/providers/openai/Request.ts",
] as const

/** True for `Effect.serviceOption`, `Plugin.optional` and `GraftPlugin.optional`. */
const isLookup = (parts: ReadonlyArray<string>): boolean => {
	const name = Arr.join(parts, ".")
	return (
		name === "Effect.serviceOption" ||
		name === "Plugin.optional" ||
		name === "GraftPlugin.optional"
	)
}

/** True for the name of the host or of a server package. */
const isServer = (name: string | undefined): boolean =>
	name !== undefined && (name === "openbot" || isServerPackage(name))

/** The host, the HTTP files of the kernel, and the execution engine. */
const hostFiles =
	/^packages\/(?:openbot\/src\/|server-execution\/src\/|server-kernel\/src\/errors\/(?:HttpHost|HttpBoundary|Reporting)\.ts$)/

/** True for an object argument with `global: true`. */
const isGlobal = (node: Node): boolean =>
	node.type === "ObjectExpression" &&
	Arr.some(
		node.properties,
		(property) =>
			property.type === "Property" &&
			property.key.type === "Identifier" &&
			property.key.name === "global" &&
			property.value.type === "Literal" &&
			property.value.value === true,
	)

/**
 * True for a call that only the host makes: it serves HTTP, builds the HTTP
 * API, adds a global HTTP middleware, or makes a layer from a workflow.
 */
const isHostCall = (node: Node): boolean => {
	if (node.type !== "CallExpression") return false
	const parts = memberParts(node.callee)
	const name = Arr.join(parts, ".")
	if (
		name === "HttpApiBuilder.layer" ||
		name === "HttpRouter.serve" ||
		name === "HttpRouter.toWebHandler" ||
		name === "HttpRouter.cors"
	)
		return true
	if (name === "HttpRouter.middleware")
		return Arr.some(node.arguments, isGlobal)
	if (
		node.callee.type === "MemberExpression" &&
		Equal.equals(propertyName(node.callee), Option.some("addGlobalMiddleware"))
	)
		return true
	if (
		node.callee.type !== "MemberExpression" ||
		!Equal.equals(propertyName(node.callee), Option.some("toLayer"))
	)
		return false
	const object = node.callee.object
	// `Workflow.make(...).toLayer(...)`: the workflow is made in place.
	if (object.type === "CallExpression")
		return /^(?:.*\.)?Workflow\.make$/.test(
			Arr.join(memberParts(object.callee), "."),
		)
	// `TriggerWorkflow.toLayer(...)` or `contribution.workflow.toLayer(...)`.
	return Option.match(Arr.last(memberParts(object)), {
		onNone: () => false,
		onSome: (last) => /workflow$/i.test(last),
	})
}

const check = (file: string, program: Node) => {
	const main = Str.endsWith("Main.ts")(file)
	const owner = /^packages\/([^/]+)\/src\//.exec(file)?.[1]
	const server = isServer(owner)
	const domain = Str.startsWith("packages/domain/src/")(file)
	const core = coreImports(program)
	const blind = isBlind(blindNames(program))
	// The code and the tests of a server package must not look for a feature.
	const lookups =
		isServer(/^packages\/([^/]+)\//.exec(file)?.[1]) &&
		!Arr.contains(lookupFiles, file)
	const hosting = server && !hostFiles.test(file)
	return (node: Node): ReadonlyArray<Rule> => {
		if (server || domain) {
			const [head, ...tail] = memberParts(node)
			const imported =
				head === undefined || !Rec.has(core, head) ? undefined : core[head]
			const name =
				imported === undefined ? "" : Arr.join([...imported, ...tail], ".")
			if (
				server &&
				/^(?:ChatRuntime(?:\.|$)|Operations\.(?:make|layer)$)/.test(name)
			)
				return ["execution-boundary"]
			if (
				domain &&
				/^(?:ChatRuntime|Operations|TurnRunner|ModelStep|ToolStep|ChatStoreRepository|ChatStoreMemory|MemoryPersistence)(?:\.|$)/.test(
					name,
				)
			)
				return ["domain-boundary"]
		}
		if (node.type === "ThrowStatement") return ["throw"]
		if (node.type !== "CallExpression") return []
		if (lookups && isLookup(memberParts(node.callee))) return ["feature-lookup"]
		if (hosting && isHostCall(node)) return ["host-only"]
		const name = propertyName(node.callee)
		if (Option.isNone(name)) return []
		if (name.value === "mapError" || name.value === "orElseFail")
			return Option.match(Arr.last(node.arguments), {
				onNone: () => [],
				onSome: (handler) => (blind(handler) ? ["blind-error-map"] : []),
			})
		if (name.value === "try" || name.value === "tryPromise")
			return Arr.flatMap(node.arguments, (argument) =>
				argument.type === "ObjectExpression"
					? Arr.flatMap(argument.properties, (property) =>
							property.type === "Property" &&
							property.key.type === "Identifier" &&
							property.key.name === "catch" &&
							blind(property.value)
								? ["blind-error-map" as const]
								: [],
						)
					: [],
			)
		if (
			!main &&
			Arr.contains(runs, name.value) &&
			node.callee.type === "MemberExpression" &&
			node.callee.object.type === "Identifier" &&
			node.callee.object.name === "Effect"
		)
			return ["run-outside-main"]
		// `forkDetach` is the Effect 4 name. `forkDaemon` is the old Effect 3 name.
		if (name.value === "forkDetach" || name.value === "forkDaemon")
			return ["fork-daemon"]
		if (name.value === "then") return ["promise-then"]
		return []
	}
}

const lineOf = (node: Node) => node.loc?.start.line ?? 0

const walk =
	(visit: (node: Node) => ReadonlyArray<Rule>) =>
	(node: Node): ReadonlyArray<Omit<Finding, "file">> => [
		...Arr.map(visit(node), (rule) => ({ rule, line: lineOf(node) })),
		...Arr.flatMap(children(node), walk(visit)),
	]

/** The comment rules: each directive needs a reason, and `@effect-rules-next-line` allows a rule on the next line. */
interface Directive {
	readonly line: number
	readonly allows: ReadonlyArray<string>
	readonly reasoned: boolean
}

const directiveOf = (comment: Acorn.Comment): Option.Option<Directive> => {
	// A directive is a line comment that starts with the directive name.
	const text = Str.trim(comment.value)
	if (
		comment.type !== "Line" ||
		(!Str.startsWith("@effect-diagnostics")(text) &&
			!Str.startsWith("@effect-rules")(text))
	)
		return Option.none()
	const [head, ...reason] = Str.split(text, " -- ")
	const allows = Str.includes("@effect-rules-next-line")(head)
		? Arr.filter(
				Str.split(
					Str.trim(Str.replace("@effect-rules-next-line", "")(head)),
					/[\s,]+/,
				),
				Str.isNonEmpty,
			)
		: []
	return Option.some({
		line: comment.loc?.end.line ?? 0,
		allows,
		reasoned:
			Arr.length(Str.split(Str.trim(Arr.join(reason, " -- ")), /\s+/)) >= 2,
	})
}

const placeOf = Schema.decodeUnknownOption(
	Schema.Struct({ loc: Schema.Struct({ line: Schema.Int }) }),
)

/** These files only map an application result to the HTTP contract. */
const httpViews = [
	"packages/plugin-chats/src/ChatViews.ts",
	"packages/plugin-chats/src/ResponseMapping.ts",
] as const
/** These files connect an outside library or the HTTP contract to a feature. */
const httpAdapters = [
	...httpViews,
	"packages/plugin-auth/src/BetterAuth.ts",
	"packages/plugin-authorization/src/Layer.ts",
] as const

/** The base packages: pure types, rules and contracts. Every server package may use them. */
const basePackages = ["core", "domain", "protocol", "api"] as const
const isBasePackage = (name: string) => Arr.contains(basePackages, name)

/**
 * The packages in layers, from low to high. A package may import only
 * packages of a lower layer. The base packages have layer 0. Each plugin
 * package has the plugin number. The plugin-boundary rule keeps plugins apart.
 */
const packageLayers: Readonly<Record<string, number>> = {
	"server-database": 1,
	"server-kernel": 2,
	"identity-contract": 3,
	"server-billing": 4,
	"server-execution": 5,
	"tools-contract": 6,
	"models-contract": 7,
	"apps-contract": 8,
	"conversation-contract": 9,
	"model-providers": 10,
	"server-plugin": 11,
	plugin: 12,
	"server-upgrade": 13,
	openbot: 14,
	"server-development": 15,
	"server-testing": 16,
}

/** The server packages, without the host. Other packages use them only through their `exports`. */
const serverPackages = [
	"server-database",
	"server-kernel",
	"identity-contract",
	"server-billing",
	"server-execution",
	"tools-contract",
	"models-contract",
	"apps-contract",
	"conversation-contract",
	"model-providers",
	"server-plugin",
	"plugin-audit",
	"plugin-mail",
	"plugin-platform",
	"plugin-organization",
	"plugin-access",
	"plugin-sso",
	"plugin-auth",
	"plugin-authorization",
	"plugin-models",
	"plugin-files",
	"plugin-artifacts",
	"plugin-bots",
	"plugin-capabilities",
	"plugin-work",
	"plugin-imported",
	"plugin-chats",
	"plugin-channels",
	"plugin-apps",
	"plugin-code",
	"plugin-vaults",
	"plugin-computers",
	"plugin-triggers",
	"plugin-billing",
	"plugin-settings",
	"plugin-turn-limiter",
	"plugin-time-limiter",
	"plugin-token-limiter",
	"server-upgrade",
	"server-development",
	"server-testing",
] as const
const isServerPackage = (name: string) =>
	Arr.some(serverPackages, (server) => server === name)

/**
 * True for the name of a plugin package. A plugin package that is missing
 * from `serverPackages` still counts, so the plugin rules see it.
 */
const isPluginPackage = (name: string) =>
	Str.startsWith("plugin-")(name) && name !== "plugin"

/** True for a package that has a layer: the host, a server package, a plugin package, or a base package. */
const hasLayer = (name: string) =>
	name === "openbot" ||
	isServerPackage(name) ||
	isPluginPackage(name) ||
	isBasePackage(name)

/** The package of a file, when that package has a layer. */
const unitOf = (file: string): Option.Option<string> => {
	const own = /^packages\/([^/]+)\//.exec(file)
	return own !== null && hasLayer(own[1]!)
		? Option.some(own[1]!)
		: Option.none()
}

/** The package that an import names: a relative path, or the entry of a package. */
const targetUnit = (
	target: string,
	resolved: string,
): Option.Option<string> => {
	if (Str.startsWith(".")(target)) return unitOf(resolved)
	const entry = /^@openbot-build\/([^/]+)(?:\/|$)/.exec(target)
	return entry !== null && hasLayer(entry[1]!)
		? Option.some(entry[1]!)
		: Option.none()
}

/** True when a plugin package imports another plugin package. */
const crossesPlugins = (
	file: string,
	target: string,
	resolved: string,
): boolean => {
	const from = unitOf(file)
	const to = targetUnit(target, resolved)
	return (
		Option.isSome(from) &&
		Option.isSome(to) &&
		isPluginPackage(from.value) &&
		isPluginPackage(to.value) &&
		from.value !== to.value
	)
}

const layerOf = (unit: string): number | undefined =>
	isPluginPackage(unit)
		? packageLayers["plugin"]
		: isBasePackage(unit)
			? 0
			: packageLayers[unit]

/** The products that the database package may use: pure types and rules, and its own entries. */
const databaseImports =
	/^@openbot-build\/(?:core|domain|server-database)(?:\/|$)/

/**
 * True when an import goes to the same or a higher layer, or when the
 * database package imports a product other than core and domain.
 */
const breaksLayers = (
	file: string,
	target: string,
	resolved: string,
): boolean => {
	if (
		Str.startsWith("packages/server-database/")(file) &&
		Str.startsWith("@openbot-build/")(target) &&
		!databaseImports.test(target)
	)
		return true
	// The plugin-boundary rule covers an import from one plugin into another.
	if (crossesPlugins(file, target, resolved)) return false
	const from = unitOf(file)
	const to = targetUnit(target, resolved)
	if (Option.isNone(from) || Option.isNone(to) || from.value === to.value)
		return false
	// domain-boundary and standalone-boundary order the base packages among themselves.
	if (isBasePackage(from.value) && isBasePackage(to.value)) return false
	const low = layerOf(from.value)
	const high = layerOf(to.value)
	if (low === undefined || high === undefined) return true
	return high >= low
}

/** True for a server file that may use the HTTP contract: an HTTP adapter or the host. */
const usesHttpContract = (file: string): boolean => {
	const place = /^packages\/([^/]+)\/src\/(.+)$/.exec(file)
	if (place === null) return false
	const owner = place[1]!
	const local = place[2]!
	if (owner !== "openbot" && !isServerPackage(owner)) return false
	if (/(?:Http[^/]*|Handlers?)\.ts$/.test(local)) return true
	if (Arr.contains(httpAdapters, file)) return true
	return owner === "openbot" || owner === "server-development"
}

interface Reference {
	readonly target: string
	readonly line: number
}

/** Every import and export path of a file, type imports too: Node removes them before the Effect rules parse the file. */
const referencesOf = (code: string): ReadonlyArray<Reference> => {
	// Node removes comments and strings inside type imports. Tokenize the original
	// source so those imports have the same checks as value imports.
	const comments: Array<Acorn.Comment> = []
	const tokens = Arr.fromIterable(
		Acorn.tokenizer(code, {
			ecmaVersion: "latest",
			sourceType: "module",
			onComment: comments,
		}),
	)
	const quoted = Arr.filter(tokens, (token) =>
		Arr.contains(["string", "regexp", "template"], token.type.label),
	)

	const scan = Arr.reduce(
		comments,
		code,
		(text, comment) =>
			Str.slice(0, comment.start)(text) +
			Str.repeat(comment.end - comment.start)(" ") +
			Str.slice(comment.end)(text),
	)
	const matches = Arr.fromIterable(
		Str.matchAll(
			/\b(?:(?:import|export)\b\s*(?:type\b\s*)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s*\bfrom\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g,
		)(scan),
	)
	return Arr.flatMap(matches, (match): ReadonlyArray<Reference> => {
		// matchAll always gives an index. Effect types it as optional.
		const index = match.index!
		if (
			Arr.some(
				[...comments, ...quoted],
				(node) => index >= node.start && index < node.end,
			)
		)
			return []
		return [
			{
				target: match[1]!,
				line: Str.split(Str.slice(0, index)(code), "\n").length,
			},
		]
	})
}

/** A path inside a package that is not its public entry. */
const inside = /^@openbot-build\/[^/]+\/(?:src|dist|migrations)(?:\/|$)/

/** The keys of `exports` in the package.json of each server package and of the host, such as `./Schema`. */
type Entries = Readonly<Record<string, ReadonlyArray<string>>>

const PackageExports = Schema.fromJsonString(
	Schema.Struct({
		exports: Schema.Record(Schema.String, Schema.Unknown),
	}),
)

/** The packages whose `exports` keys the public-entry rule checks: the server packages and the host. */
const entryPackages = [...serverPackages, "openbot"] as const
const hasEntries = (name: string) => Arr.contains(entryPackages, name)

/** Reads the `exports` keys of every server package and of the host. */
const readEntries = Effect.fn("EffectRules.readEntries")(function* () {
	const fs = yield* FileSystem.FileSystem
	const pairs = yield* Effect.forEach(entryPackages, (name) =>
		fs.readFileString(`packages/${name}/package.json`).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(PackageExports)),
			Effect.map((manifest) => [name, Rec.keys(manifest.exports)] as const),
		),
	)
	return Rec.fromEntries(pairs) satisfies Entries
})

/**
 * True when an import names a subpath of a server package or of the host that
 * is not a key of its `exports`.
 */
const unknownEntry = (target: string, served: Entries): boolean => {
	const entry = /^@openbot-build\/([^/]+)(\/.*)?$/.exec(target)
	if (entry === null || !hasEntries(entry[1]!)) return false
	const key = entry[2] === undefined ? "." : `.${entry[2]}`
	return !Arr.contains(served[entry[1]!] ?? [], key)
}

/**
 * The tests and other files of a package outside `src`. They may use the
 * source of other packages for test helpers, but a server package only
 * through its public entry. The tests of a server package stay inside it and
 * keep its layer.
 */
const entries = (
	file: string,
	code: string,
	path: Path.Path,
	served: Entries,
): ReadonlyArray<Omit<Finding, "file">> => {
	const source = /^packages\/([^/]+)\//.exec(file)
	if (source === null) return []
	const owner = source[1]!
	return Arr.flatMap(
		referencesOf(code),
		({ target, line }): ReadonlyArray<Omit<Finding, "file">> => {
			const relative = Str.startsWith(".")(target)
			const resolved = relative
				? path.normalize(path.join(path.dirname(file), target))
				: target
			const into = /^packages\/([^/]+)\//.exec(resolved)
			const server = owner === "openbot" || isServerPackage(owner)
			const found: ReadonlyArray<Rule> = [
				...(breaksLayers(file, target, resolved)
					? ["package-layer" as const]
					: []),
				...(crossesPlugins(file, target, resolved)
					? ["plugin-boundary" as const]
					: []),
				...((relative &&
					into !== null &&
					into[1] !== owner &&
					(server || isServerPackage(into[1]!))) ||
				inside.test(target) ||
				unknownEntry(target, served)
					? ["public-entry" as const]
					: []),
			]
			return Arr.map(found, (rule) => ({ line, rule, detail: target }))
		},
	)
}

const boundaries = (
	file: string,
	code: string,
	path: Path.Path,
	served: Entries,
): ReadonlyArray<Omit<Finding, "file">> => {
	const source = /^packages\/([^/]+)\/src\//.exec(file)
	if (source === null) return entries(file, code, path, served)
	const owner = source[1]!
	const server = owner === "openbot" || isServerPackage(owner)
	return Arr.flatMap(
		referencesOf(code),
		({ target, line }): ReadonlyArray<Omit<Finding, "file">> => {
			const relative = Str.startsWith(".")(target)
			const resolved = relative
				? path.normalize(path.join(path.dirname(file), target))
				: target
			const product = Str.startsWith("@openbot-build/")(target)
			const core =
				target === "@openbot-build/core" ||
				Str.startsWith("@openbot-build/core/")(target)
			const found: ReadonlyArray<Rule> = [
				...(owner === "domain" &&
				((product && !core) ||
					/^(?:effect\/(?:http|rpc|sql|cluster|workflow|process)|@effect\/(?:platform|sql)|node:|bun:)/.test(
						target,
					))
					? ["domain-boundary" as const]
					: []),
				...(server &&
				!usesHttpContract(file) &&
				(target === "@openbot-build/api" ||
					Str.startsWith("@openbot-build/api/")(target) ||
					Str.startsWith("effect/http-api")(target) ||
					(relative && Arr.contains(httpViews, resolved)))
					? ["storage-contract-boundary" as const]
					: []),
				...((owner === "core" || owner === "protocol") && product && !core
					? ["standalone-boundary" as const]
					: []),
				...(server &&
				/^effect\/(?:cluster|rpc)(?:\/|$)/.test(target) &&
				!/^packages\/(?:server-execution|openbot)\/src\//.test(file)
					? ["execution-boundary" as const]
					: []),
				...(breaksLayers(file, target, resolved)
					? ["package-layer" as const]
					: []),
				...(crossesPlugins(file, target, resolved)
					? ["plugin-boundary" as const]
					: []),
				...((relative &&
					/^packages\//.test(resolved) &&
					!Str.startsWith(`packages/${owner}/`)(resolved)) ||
				inside.test(target) ||
				unknownEntry(target, served)
					? ["public-entry" as const]
					: []),
			]
			return Arr.map(found, (rule) => ({ line, rule, detail: target }))
		},
	)
}

/** The places of OpenBot that may import graft. */
const graftPlaces = [
	/^packages\/server-plugin\/(?:src|test)\//,
	/^packages\/plugin-[^/]+\/src\/index\.ts$/,
	/^packages\/openbot\/src\//,
	/^packages\/server-development\/(?:src|test)\//,
	/^packages\/server-testing\/test\//,
	/^packages\/openbot\/test\//,
] as const

/**
 * Checks each import of graft: the file must be in a place that may use it,
 * and graft's `Plugin` must have the name `GraftPlugin`. It reads the source
 * with comments taken out, so type imports count too.
 */
const graftImports = (
	file: string,
	code: string,
): ReadonlyArray<Omit<Finding, "file">> => {
	const allowed = Arr.some(graftPlaces, (place) => place.test(file))
	const comments: Array<Acorn.Comment> = []
	Arr.fromIterable(
		Acorn.tokenizer(code, {
			ecmaVersion: "latest",
			sourceType: "module",
			onComment: comments,
		}),
	)
	// Blank out each comment with the same length, so the places stay right.
	const scan = Arr.reduce(
		comments,
		code,
		(text, comment) =>
			Str.slice(0, comment.start)(text) +
			Str.repeat(comment.end - comment.start)(" ") +
			Str.slice(comment.end)(text),
	)
	const imports = Arr.fromIterable(
		Str.matchAll(
			/\b(?:import|export)\b\s*(?:type\b\s*)?((?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+))\s*\bfrom\s*["'](@graftland\/[^"']+)["']|\bimport\s*\(\s*["'](@graftland\/[^"']+)["']/g,
		)(scan),
	)
	return Arr.flatMap(imports, (match): ReadonlyArray<Omit<Finding, "file">> => {
		// matchAll always gives an index. Effect types it as optional.
		const line = Str.split(Str.slice(0, match.index!)(code), "\n").length
		const target = match[2] ?? match[3] ?? ""
		const named = /\{([^}]*)\}/.exec(match[1] ?? "")
		const misnamed =
			target === "@graftland/graft" &&
			named !== null &&
			Arr.some(Str.split(named[1]!, ","), (specifier) => {
				const parts = Arr.filter(
					Str.split(Str.trim(specifier), /\s+/),
					(part) => part !== "type",
				)
				return parts[0] === "Plugin" && parts[2] !== "GraftPlugin"
			})
		return !allowed || misnamed
			? [{ line, rule: "graft-boundary", detail: target }]
			: []
	})
}

/** The `src/index.ts` file of a plugin package. */
const pluginIndex = /^packages\/plugin-[^/]+\/src\/index\.ts$/

/** The name that an export specifier gives: an identifier, or a string such as `"default"`. */
const exportedName = (specifier: unknown): Option.Option<unknown> =>
	Predicate.hasProperty(specifier, "exported") &&
	Predicate.hasProperty(specifier.exported, "type")
		? specifier.exported.type === "Identifier" &&
			Predicate.hasProperty(specifier.exported, "name")
			? Option.some(specifier.exported.name)
			: Predicate.hasProperty(specifier.exported, "value")
				? Option.some(specifier.exported.value)
				: Option.none()
		: Option.none()

/** True for `export default …`, and for `export { x as default }` with no other name. */
const onlyDefault = (node: Node): boolean =>
	node.type === "ExportDefaultDeclaration" ||
	(node.type === "ExportNamedDeclaration" &&
		node.declaration === null &&
		node.specifiers.length === 1 &&
		Equal.equals(exportedName(node.specifiers[0]), Option.some("default")))

/**
 * Checks that the `src/index.ts` file of a plugin package has one export
 * only, the plugin as the default export. It counts the `export` words of the
 * source, so it sees type exports too, which Node takes out before the parse.
 */
const pluginEntry = (
	file: string,
	code: string,
	program: Node,
): ReadonlyArray<Omit<Finding, "file">> => {
	if (!pluginIndex.test(file)) return []
	const words = Arr.filter(
		Arr.fromIterable(
			Acorn.tokenizer(code, {
				ecmaVersion: "latest",
				sourceType: "module",
				locations: true,
			}),
		),
		(token) => token.type.keyword === "export",
	)
	const extra = Arr.map(Arr.drop(words, 1), (token): Omit<Finding, "file"> => ({
		line: token.loc?.start.line ?? 1,
		rule: "plugin-entry",
		detail: "another export",
	}))
	const exported = Arr.filter(
		program.type === "Program" ? program.body : [],
		(node) =>
			node.type === "ExportNamedDeclaration" ||
			node.type === "ExportDefaultDeclaration" ||
			node.type === "ExportAllDeclaration",
	)
	const plugin = Arr.some(exported, onlyDefault)
	return [
		...extra,
		...(plugin
			? []
			: [
					{
						line: Option.match(Arr.head(exported), {
							onNone: () => 1,
							onSome: (node) => node.loc?.start.line ?? 1,
						}),
						rule: "plugin-entry" as const,
						detail: "no default export of the plugin",
					},
				]),
	]
}

/**
 * Keys that live in a kernel package, but that a plugin gives. The kernel holds
 * the tag, so the host can name it in the types of its routes. The billing and
 * imported plugins give the service.
 */
const pluginSlots = [
	"@openbot-build/server-billing/billing/Host",
	"@openbot-build/server-execution/imported/ImportedRecords",
] as const

/** The packages whose keys a plugin may publish: the contract packages, api, domain and protocol. */
const publishable =
	/^@openbot-build\/(?:api|domain|protocol|identity-contract|tools-contract|models-contract|apps-contract|conversation-contract)(?:\/|$)/

/** True when a key that comes from this import path is a key of the kernel or of a library. */
const forbiddenKey = (owner: string, source: string): boolean =>
	!Str.startsWith(".")(source) &&
	!publishable.test(source) &&
	!Arr.contains(pluginSlots, source) &&
	// A package may name its own keys through its own entries.
	!Str.startsWith(`@openbot-build/${owner}/`)(source) &&
	source !== `@openbot-build/${owner}`

/**
 * Checks the keys that a server file publishes: the `publishes` and
 * `published` arrays, and the first argument of `Graft.provide`. A key must
 * not come from a kernel package or a library. It follows the names of arrays
 * of the same file, and leaves out spreads of other modules, because the rules
 * check those files too. The preset test of `server-testing` checks the same
 * at run time.
 */
const kernelKeys = (
	file: string,
	program: Node,
): ReadonlyArray<Omit<Finding, "file">> => {
	const owner = /^packages\/([^/]+)\/src\//.exec(file)?.[1]
	if (!isServer(owner)) return []
	const nodes = descendants(program)
	const imports = Rec.fromEntries(
		Arr.flatMap(nodes, (node): ReadonlyArray<readonly [string, string]> =>
			node.type === "ImportDeclaration" && typeof node.source.value === "string"
				? Arr.map(
						node.specifiers,
						(specifier) =>
							[specifier.local.name, String(node.source.value)] as const,
					)
				: [],
		),
	)
	const arrays = Rec.fromEntries(
		Arr.flatMap(nodes, (node): ReadonlyArray<readonly [string, Node]> =>
			node.type === "VariableDeclarator" &&
			node.id.type === "Identifier" &&
			node.init?.type === "ArrayExpression"
				? [[node.id.name, node.init] as const]
				: [],
		),
	)
	const isKeyList = (name: string) =>
		name === "publishes" || name === "published"
	const lists = Arr.flatMap(nodes, (node): ReadonlyArray<Node> => {
		if (
			node.type === "VariableDeclarator" &&
			node.id.type === "Identifier" &&
			isKeyList(node.id.name) &&
			node.init?.type === "ArrayExpression"
		)
			return [node.init]
		if (
			node.type === "Property" &&
			node.key.type === "Identifier" &&
			isKeyList(node.key.name)
		)
			return node.value.type === "ArrayExpression"
				? [node.value]
				: node.value.type === "Identifier" && Rec.has(arrays, node.value.name)
					? [arrays[node.value.name]!]
					: []
		if (
			node.type === "CallExpression" &&
			Arr.join(Arr.takeRight(memberParts(node.callee), 2), ".") ===
				"Graft.provide"
		)
			return Arr.take(node.arguments, 1)
		return []
	})
	const keysOf = (
		node: Node,
		seen: HashSet.HashSet<string>,
	): ReadonlyArray<Node> => {
		switch (node.type) {
			case "ArrayExpression":
				return Arr.flatMap(node.elements, (element) =>
					element === null ? [] : keysOf(element, seen),
				)
			case "SpreadElement":
				// Follow an array of this file once. A spread of another module is checked in its own file.
				return node.argument.type === "Identifier" &&
					Rec.has(arrays, node.argument.name) &&
					!HashSet.has(seen, node.argument.name)
					? keysOf(
							arrays[node.argument.name]!,
							HashSet.add(seen, node.argument.name),
						)
					: []
			case "Identifier":
			case "MemberExpression":
				return [node]
			default:
				return []
		}
	}
	// `publishes` names an array of the file, so the same array can come twice.
	const unique = Arr.dedupeWith(lists, (a, b) => a === b)
	return Arr.flatMap(unique, (list) =>
		Arr.flatMap(keysOf(list, HashSet.empty()), (key) =>
			Option.match(Arr.head(memberParts(key)), {
				onNone: () => [],
				onSome: (head) => {
					// A key declared in the file has no import, so it is the plugin's own.
					const source = Rec.has(imports, head) ? imports[head] : undefined
					return source !== undefined && forbiddenKey(owner!, source)
						? [
								{
									line: lineOf(key),
									rule: "kernel-provide" as const,
									detail: source,
								},
							]
						: []
				},
			}),
		),
	)
}

const checkFile = Effect.fn("EffectRules.checkFile")(function* (
	file: string,
	served: Entries,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const code = yield* fs.readFileString(file)
	const comments: Array<Acorn.Comment> = []
	const parsed = yield* Effect.try(() =>
		Acorn.parse(stripTypeScriptTypes(code, { mode: "strip" }), {
			ecmaVersion: "latest",
			sourceType: "module",
			locations: true,
			onComment: comments,
		}),
	).pipe(Effect.result)
	if (Result.isFailure(parsed)) {
		// An Acorn error gives its line in `loc`. A Node error names the TypeScript syntax that Node cannot strip.
		const cause = parsed.failure.cause
		return [
			{
				file,
				line: Option.match(placeOf(cause), {
					onNone: () => 1,
					onSome: (place) => place.loc.line,
				}),
				rule: "parse" as const,
				detail: Predicate.isError(cause) ? cause.message : String(cause),
			},
		] satisfies ReadonlyArray<Finding>
	}
	const directives = Arr.getSomes(Arr.map(comments, directiveOf))
	const allowed = (finding: Omit<Finding, "file">) =>
		Arr.some(
			directives,
			(directive) =>
				directive.reasoned &&
				directive.line === finding.line - 1 &&
				Arr.contains(directive.allows, finding.rule),
		)
	const found = Arr.filter(
		walk(check(file, parsed.success))(parsed.success),
		(finding) => !allowed(finding),
	)
	const unreasoned = pipe(
		directives,
		Arr.filter((directive) => !directive.reasoned),
		Arr.map((directive) => ({
			line: directive.line,
			rule: "directive-reason" as const,
		})),
	)
	return Arr.map(
		[
			...found,
			...unreasoned,
			...boundaries(file, code, path, served),
			...graftImports(file, code),
			...pluginEntry(file, code, parsed.success),
			...kernelKeys(file, parsed.success),
		],
		(finding): Finding => ({
			file,
			...finding,
		}),
	)
})

/**
 * Lists the TypeScript files under a folder, one folder at a time. It does not
 * go into a skipped folder. A recursive `readDirectory` goes into
 * node_modules first and follows its links to other packages, and their
 * node_modules again. With many packages that list gets too large for memory.
 */
const sourceFiles = (
	folder: string,
): Effect.Effect<
	ReadonlyArray<string>,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const names = yield* fs.readDirectory(folder)
		const lists = yield* Effect.forEach(
			Arr.filter(names, (name) => !Arr.contains(skipped, name)),
			(name) => {
				const file = path.join(folder, name)
				return fs
					.stat(file)
					.pipe(
						Effect.flatMap((info) =>
							info.type === "Directory"
								? sourceFiles(file)
								: Effect.succeed(
										Str.endsWith(".ts")(name) && !Str.endsWith(".d.ts")(name)
											? [file]
											: [],
									),
						),
					)
			},
		)
		return Arr.flatten(lists)
	})

const program = Effect.gen(function* () {
	const path = yield* Path.Path
	const files = yield* Effect.forEach(roots, sourceFiles).pipe(
		Effect.map(Arr.flatten),
	)
	const served = yield* readEntries()
	const fs = yield* FileSystem.FileSystem
	// A server or plugin package that is missing from `serverPackages` would
	// miss the checks of its entries and its layer.
	const unlisted = Arr.filter(
		yield* fs.readDirectory("packages"),
		(name) =>
			(isPluginPackage(name) ||
				Str.startsWith("server-")(name) ||
				Str.endsWith("-contract")(name)) &&
			!isServerPackage(name),
	)
	const codeFindings = yield* Effect.forEach(
		files,
		(file) => checkFile(file, served),
		{ concurrency: 16 },
	).pipe(Effect.map(Arr.flatten))
	const findings: ReadonlyArray<Finding> = [
		...codeFindings,
		...Arr.map(unlisted, (name): Finding => ({
			file: `packages/${name}/package.json`,
			line: 1,
			rule: "package-layer",
			detail: `packages/${name} is not in serverPackages of scripts/effect-rules.ts`,
		})),
		...(yield* ServiceContracts.check(
			Arr.map(files, (file) => path.resolve(file)),
		)),
	]
	yield* Effect.forEach(
		findings,
		(finding) =>
			Console.error(
				`${finding.file}:${finding.line}: ${finding.rule}: ${rules[finding.rule]}${finding.detail === undefined ? "" : ` ${finding.detail}`}`,
			),
		{ discard: true },
	)
	if (Arr.isReadonlyArrayNonEmpty(findings))
		return yield* EffectRulesFailed.make({
			message: `${Arr.length(findings)} places break the Effect rules.`,
		})
	yield* Console.log(`The Effect rules pass in ${Arr.length(files)} files.`)
})

program.pipe(
	// @effect-diagnostics-next-line strictEffectProvide:off -- This script is a program entry point, so it gives the services here.
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
)
