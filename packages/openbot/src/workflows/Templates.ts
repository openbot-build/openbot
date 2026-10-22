// These are plain functions of a template and its values. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import type { WorkflowsApi } from "@openbot-build/api"
import { Predicate, Result, type Schema } from "effect"

/** The values that templates can read while a Run goes on. */
export interface Scope {
	readonly input: Schema.JsonObject
	readonly nodes: Readonly<Record<string, { readonly output: Schema.Json }>>
}

const placeholder = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g
const whole = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/

/** The value at a path such as `input.user.name` or `nodes.login.output`. */
const lookup = (
	scope: Scope,
	path: string,
): Result.Result<Schema.Json, string> => {
	const [root, ...rest] = path.split(".")
	const start: unknown =
		root === "input" ? scope.input : root === "nodes" ? scope.nodes : undefined
	if (start === undefined)
		return Result.fail(`{{${path}}} must start with input or nodes.`)
	let current: unknown = start
	for (const key of rest) {
		if (!Predicate.isObject(current) || !Object.hasOwn(current, key))
			return Result.fail(`There is no value at {{${path}}}.`)
		current = (current as Record<string, unknown>)[key]
	}
	return Result.succeed(current as Schema.Json)
}

const asText = (value: Schema.Json) =>
	typeof value === "string" ? value : JSON.stringify(value)

/** Puts the values into a text. A value that is not text goes in as JSON. */
export const text = (
	template: string,
	scope: Scope,
): Result.Result<string, string> => {
	let failure: string | undefined
	const rendered = template.replace(placeholder, (_, path: string) => {
		const value = lookup(scope, path)
		if (Result.isFailure(value)) {
			failure ??= value.failure
			return ""
		}
		return asText(value.success)
	})
	return failure === undefined ? Result.succeed(rendered) : Result.fail(failure)
}

/**
 * Puts the values into JSON arguments. A text that is only one template, such as
 * `"{{input.count}}"`, becomes the value itself, so numbers stay numbers.
 */
export const json = (
	value: Schema.Json,
	scope: Scope,
): Result.Result<Schema.Json, string> => {
	if (typeof value === "string") {
		const only = whole.exec(value)
		return only === null ? text(value, scope) : lookup(scope, only[1]!)
	}
	if (Array.isArray(value)) {
		const items: Array<Schema.Json> = []
		for (const item of value) {
			const rendered = json(item, scope)
			if (Result.isFailure(rendered)) return rendered
			items.push(rendered.success)
		}
		return Result.succeed(items)
	}
	if (Predicate.isObject(value)) {
		const entries: Array<[string, Schema.Json]> = []
		for (const [key, item] of Object.entries(value)) {
			const rendered = json(item as Schema.Json, scope)
			if (Result.isFailure(rendered)) return rendered
			entries.push([key, rendered.success])
		}
		return Result.succeed(Object.fromEntries(entries))
	}
	return Result.succeed(value)
}

/** The answer of a condition: whether it is true, the text it compared, and why it is false. */
export type Checked =
	| { readonly passed: true; readonly value: string }
	| { readonly passed: false; readonly value: string; readonly reason: string }

/**
 * Checks a condition, such as an `Expect` node or the `when` of a node.
 * It fails only when the condition cannot be checked, for example when a template has no value.
 */
export const condition = (
	step: WorkflowsApi.Condition,
	scope: Scope,
): Result.Result<Checked, string> => {
	const actual = text(step.value, scope)
	if (Result.isFailure(actual)) return Result.fail(actual.failure)
	const expected = text(step.expected ?? "", scope)
	if (Result.isFailure(expected)) return Result.fail(expected.failure)
	const value = actual.success
	const wanted = expected.success
	const passed = (() => {
		switch (step.operator) {
			case "equals":
				return value === wanted
			case "contains":
				return value.includes(wanted)
			case "matches":
				try {
					return new RegExp(wanted, "u").test(value)
				} catch {
					return undefined
				}
			case "not_empty":
				return value.trim().length > 0
		}
	})()
	if (passed === undefined)
		return Result.fail(`The pattern ${JSON.stringify(wanted)} is not valid.`)
	return Result.succeed(
		passed
			? { passed: true, value }
			: {
					passed: false,
					value,
					reason:
						step.operator === "not_empty"
							? "The value is empty."
							: `Expected the value to ${step.operator.replace("_", " ")} ${JSON.stringify(wanted)}, but it is ${JSON.stringify(value)}.`,
				},
	)
}

/** Checks an `Expect` node. It returns the text it compared, or why the check failed. */
export const expect = (
	step: WorkflowsApi.Condition,
	scope: Scope,
): Result.Result<string, string> =>
	Result.flatMap(condition(step, scope), (checked) =>
		checked.passed
			? Result.succeed(checked.value)
			: Result.fail(checked.reason),
	)
