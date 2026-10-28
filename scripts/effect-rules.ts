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
	FileSystem,
	flow,
	HashSet,
	Option,
	Path,
	pipe,
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
	"assembly-boundary":
		"A feature must not import the application entry points or layer assembly.",
	"public-entry":
		"Use the public entry of another package, not its source files.",
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

const check = (file: string, program: Node) => {
	const main = Str.endsWith("Main.ts")(file)
	const server = Str.startsWith("packages/openbot/src/")(file)
	const domain = Str.startsWith("packages/domain/src/")(file)
	const core = coreImports(program)
	const blind = isBlind(blindNames(program))
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
const httpViews = ["chats/ChatViews.ts", "chats/ResponseMapping.ts"] as const
const httpAdapters = [
	...httpViews,
	"auth/BetterAuth.ts",
	"authorization/Layer.ts",
] as const

const usesHttpContract = (file: string): boolean => {
	const local = Str.replace("packages/openbot/src/", "")(file)
	return (
		Str.startsWith("app/")(local) ||
		/(?:Http[^/]*|Handlers?)\.ts$/.test(local) ||
		Arr.some(httpAdapters, (adapter) => local === adapter)
	)
}

/** Check type imports too: Node removes them before the Effect rules parse the file. */
const boundaries = (
	file: string,
	code: string,
	path: Path.Path,
): ReadonlyArray<Omit<Finding, "file">> => {
	const source = /^packages\/([^/]+)\/src\//.exec(file)
	if (source === null) return []
	const owner = source[1]
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
	const references = Arr.fromIterable(
		Str.matchAll(
			/\b(?:(?:import|export)\b\s*(?:type\b\s*)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s*\bfrom\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g,
		)(scan),
	)
	return Arr.flatMap(
		references,
		(match): ReadonlyArray<Omit<Finding, "file">> => {
			// matchAll always gives an index. Effect types it as optional.
			const index = match.index!
			if (
				Arr.some(
					[...comments, ...quoted],
					(node) => index >= node.start && index < node.end,
				)
			)
				return []
			const target = match[1]!
			const line = Str.split(Str.slice(0, index)(code), "\n").length
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
				...(owner === "openbot" &&
				!usesHttpContract(file) &&
				(target === "@openbot-build/api" ||
					Str.startsWith("@openbot-build/api/")(target) ||
					Str.startsWith("effect/http-api")(target) ||
					(relative &&
						Arr.some(
							httpViews,
							(view) => resolved === `packages/openbot/src/${view}`,
						)))
					? ["storage-contract-boundary" as const]
					: []),
				...((owner === "core" || owner === "protocol") && product && !core
					? ["standalone-boundary" as const]
					: []),
				...(owner === "openbot" &&
				/^effect\/(?:cluster|rpc)(?:\/|$)/.test(target) &&
				!/^packages\/openbot\/src\/(?:execution|resources|transport|app)\//.test(
					file,
				)
					? ["execution-boundary" as const]
					: []),
				...(owner === "openbot" &&
				/^packages\/openbot\/src\/[^/]+\//.test(file) &&
				!Str.startsWith("packages/openbot/src/app/")(file) &&
				Str.startsWith("packages/openbot/src/app/")(resolved)
					? ["assembly-boundary" as const]
					: []),
				...((relative &&
					/^packages\//.test(resolved) &&
					!Str.startsWith(`packages/${owner}/`)(resolved)) ||
				/^@openbot-build\/[^/]+\/(?:src|dist)(?:\/|$)/.test(target)
					? ["public-entry" as const]
					: []),
			]
			return Arr.map(found, (rule) => ({ line, rule, detail: target }))
		},
	)
}

const checkFile = Effect.fn("EffectRules.checkFile")(function* (file: string) {
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
		[...found, ...unreasoned, ...boundaries(file, code, path)],
		(finding): Finding => ({
			file,
			...finding,
		}),
	)
})

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const files = yield* Effect.forEach(roots, (root) =>
		fs.readDirectory(root, { recursive: true }).pipe(
			Effect.map(
				flow(
					Arr.filter(
						(entry) =>
							Str.endsWith(".ts")(entry) &&
							!Str.endsWith(".d.ts")(entry) &&
							!Arr.some(Str.split(entry, path.sep), (part) =>
								Arr.contains(skipped, part),
							),
					),
					Arr.map((entry) => path.join(root, entry)),
				),
			),
		),
	).pipe(Effect.map(Arr.flatten))
	const codeFindings = yield* Effect.forEach(files, checkFile, {
		concurrency: 16,
	}).pipe(Effect.map(Arr.flatten))
	const findings: ReadonlyArray<Finding> = [
		...codeFindings,
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
