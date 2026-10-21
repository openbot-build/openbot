// These are plain functions of a template and its values. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import type { WorkflowsApi } from "@openbot-build/api"
import { Predicate, Result, type Schema } from "effect"

/** The values that templates can read while a Run goes on. */
export interface Scope {
	readonly input: Schema.JsonObject
	readonly vars: Schema.JsonObject
	readonly steps: Readonly<Record<string, { readonly output: Schema.Json }>>
}

const placeholder = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g
const whole = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/

/** The value at a path such as `input.user.name` or `steps.login.output`. */
const lookup = (
	scope: Scope,
	path: string,
): Result.Result<Schema.Json, string> => {
	const [root, ...rest] = path.split(".")
	const start: unknown =
		root === "input"
			? scope.input
			: root === "vars"
				? scope.vars
				: root === "steps"
					? scope.steps
					: undefined
	if (start === undefined)
		return Result.fail(`{{${path}}} must start with input, vars or steps.`)
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

/** Checks an `Expect` step. It returns the text it compared, or why the check failed. */
export const expect = (
	step: Extract<WorkflowsApi.Step, { readonly _tag: "Expect" }>,
	scope: Scope,
): Result.Result<string, string> => {
	const actual = text(step.value, scope)
	if (Result.isFailure(actual)) return actual
	const expected = text(step.expected ?? "", scope)
	if (Result.isFailure(expected)) return expected
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
	return passed
		? Result.succeed(value)
		: Result.fail(
				step.operator === "not_empty"
					? "The value is empty."
					: `Expected the value to ${step.operator.replace("_", " ")} ${JSON.stringify(wanted)}, but it is ${JSON.stringify(value)}.`,
			)
}
