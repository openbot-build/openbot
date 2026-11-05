import {
	Array as Arr,
	Effect,
	HashSet,
	Option,
	Schema,
	String as Str,
} from "effect"
import {
	API,
	SymbolFlags,
	type APIOptions,
	type Checker,
} from "typescript/unstable/sync"
import {
	type Node,
	type SourceFile,
	type TypeNode,
} from "typescript/unstable/ast"
import * as Ts from "typescript/unstable/ast"

export interface Finding {
	readonly file: string
	readonly line: number
	readonly rule: "service-contract"
}

class CheckFailed extends Schema.TaggedError<
	CheckFailed,
	{ readonly brand: unique symbol }
>()("ServiceContractCheckFailed", { cause: Schema.Defect() }) {}

const children = (node: Node): ReadonlyArray<Node> => {
	// The compiler visits its nodes through a callback.
	const nodes: Array<Node> = []
	node.forEachChild((child) => {
		nodes.push(child)
	})
	return nodes
}

const nodes = (node: Node): ReadonlyArray<Node> => [
	node,
	...Arr.flatMap(children(node), nodes),
]

/** Follow type aliases, including aliases imported from another file. */
const inferred = (
	checker: Checker,
	node: TypeNode,
	seen = HashSet.empty<number>(),
): boolean => {
	if (
		node.kind === Ts.SyntaxKind.AnyKeyword ||
		node.kind === Ts.SyntaxKind.UnknownKeyword
	)
		return true
	if (Ts.isTypeQueryNode(node)) {
		// Schema.Type and a declared Service are contracts, not constructors.
		const name = node.exprName
		return (
			!Ts.isQualifiedName(name) ||
			(name.right.text !== "Type" && name.right.text !== "Service")
		)
	}
	if (Ts.isTypeReferenceNode(node)) {
		const found = checker.getSymbolAtLocation(node.typeName)
		if (found === undefined) return false
		const symbol =
			(found.flags & SymbolFlags.Alias) !== 0
				? checker.getAliasedSymbol(found)
				: found
		if (HashSet.has(seen, symbol.id)) return false
		const next = HashSet.add(seen, symbol.id)
		return Arr.some(symbol.declarations, (handle) => {
			const declaration = handle.resolve()
			return (
				declaration !== undefined &&
				Ts.isTypeAliasDeclaration(declaration) &&
				(inferred(checker, declaration.type, next) ||
					Arr.some(node.typeArguments ?? [], (type) =>
						inferred(checker, type, next),
					))
			)
		})
	}
	if (Ts.isParenthesizedTypeNode(node))
		return inferred(checker, node.type, seen)
	if (Ts.isIntersectionTypeNode(node) || Ts.isUnionTypeNode(node))
		return Arr.some(node.types, (type) => inferred(checker, type, seen))
	if (Ts.isIndexedAccessTypeNode(node))
		return inferred(checker, node.objectType, seen)
	if (Ts.isConditionalTypeNode(node))
		return inferred(checker, node.checkType, seen)
	return false
}

const inspect = (
	file: string,
	source: SourceFile,
	checker: Checker,
): ReadonlyArray<Finding> =>
	Arr.flatMap(nodes(source), (node): ReadonlyArray<Finding> => {
		if (!Ts.isCallExpression(node) || node.typeArguments === undefined)
			return []
		if (
			Ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text !== "Service"
		)
			return []
		const found = checker.getSymbolAtLocation(node.expression)
		if (found === undefined) return []
		const symbol =
			(found.flags & SymbolFlags.Alias) !== 0
				? checker.getAliasedSymbol(found)
				: found
		if (
			symbol.name !== "Service" ||
			!Arr.some(symbol.declarations, (declaration) =>
				// TypeScript gives lower-case paths on a case-insensitive file system.
				/\/effect\/(?:src|dist)\/Context\.(?:d\.)?ts$/i.test(declaration.path),
			)
		)
			return []
		const shape = Arr.last(node.typeArguments)
		if (Option.isNone(shape)) return []
		// A constructor overload with `make` also infers the service shape.
		const inferredMake =
			node.typeArguments.length === 1 &&
			node.parent !== undefined &&
			Ts.isCallExpression(node.parent) &&
			Arr.some(
				node.parent.arguments,
				(argument) =>
					Ts.isObjectLiteralExpression(argument) &&
					Arr.some(
						argument.properties,
						(property) =>
							!Ts.isSpreadAssignment(property) &&
							property.name !== undefined &&
							Ts.isIdentifier(property.name) &&
							property.name.text === "make",
					),
			)
		if (!inferredMake && !inferred(checker, shape.value)) return []
		const text = Str.slice(shape.value.pos, shape.value.end)(source.text)
		const start = shape.value.pos + text.length - Str.trimStart(text).length
		return [
			{
				file,
				line: Str.split(Str.slice(0, start)(source.text), "\n").length,
				rule: "service-contract",
			},
		]
	})

/** The compiler owns a child process. Close it even when a check fails. */
export const check = (files: ReadonlyArray<string>, options?: APIOptions) =>
	Effect.acquireUseRelease(
		Effect.try({
			try: () => new API(options),
			catch: (cause) => CheckFailed.make({ cause }),
		}),
		(api) =>
			Effect.gen(function* () {
				const snapshot = yield* Effect.try({
					try: () => api.updateSnapshot({ openFiles: Arr.fromIterable(files) }),
					catch: (cause) => CheckFailed.make({ cause }),
				})
				return yield* Effect.forEach(files, (file) =>
					Effect.gen(function* () {
						const result = yield* Effect.try({
							try: () => {
								const project = snapshot.getDefaultProjectForFile(file)
								const source = project?.program.getSourceFile(file)
								return source === undefined || project === undefined
									? Option.none()
									: Option.some(inspect(file, source, project.checker))
							},
							catch: (cause) => CheckFailed.make({ cause }),
						})
						return yield* Effect.fromOption(result, () =>
							CheckFailed.make({
								cause: `The compiler could not read ${file}.`,
							}),
						)
					}),
				).pipe(Effect.map(Arr.flatten))
			}),
		(api) => Effect.sync(() => api.close()),
	)
