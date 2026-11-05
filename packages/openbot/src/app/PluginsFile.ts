/**
 * The plugins file (`OPENBOT_PLUGINS_FILE`): a YAML list of entries that
 * changes the entries of the preset. The host reads it one time, when it
 * starts. It never writes the file and never reads it again.
 *
 * This module has the pure rules of the file and of the entries, the stable
 * form of the entries, and their manifest hash. It does not import the
 * plugins, so `openbot-inspect` stays small. Importing it starts no I/O.
 */
import { Entry, Tree } from "@graftland/loader"
import {
	Array as Arr,
	Effect,
	FileSystem,
	HashSet,
	Option,
	Order,
	Predicate,
	Record as Rec,
	Result,
	Schema,
} from "effect"
import { Digest } from "effect/crypto"
import { LineCounter, parseDocument, type ScalarTag } from "yaml"
import * as Preset from "./Preset.ts"

/**
 * The default entries: one for each plugin of the preset, in the order of
 * `ids`. The plugins of `Preset.offByDefault` are off.
 */
export const presetEntries: ReadonlyArray<Entry.Entry> = Arr.map(
	Preset.ids,
	(id) => ({
		id,
		name: Preset.nameOf(id),
		...(Arr.contains(Preset.offByDefault, id) ? { disabled: true } : {}),
	}),
)

/**
 * The preset plugins that take config. A plugin that gets a config Schema
 * adds its id here. The limit plugins take their limit as config.
 */
export const configurable: ReadonlyArray<string> = [
	"turn-limiter",
	"time-limiter",
	"token-limiter",
]

/** The fields that an entry may have. Groups and the other loader fields are not for this file. */
const fields = ["id", "name", "disabled", "config"] as const

/** One problem of the file or of the entries. It never holds a value of the file. */
export const Problem = Schema.Struct({
	/** The place of the entry in the file, from 1. Not there for the whole file. */
	entry: Schema.optionalKey(Schema.Int),
	id: Schema.optionalKey(Schema.String),
	reason: Schema.String,
})
export type Problem = typeof Problem.Type

/** The text of one problem, such as `entry 2 (triggers): ...`. */
export const describe = (problem: Problem) => {
	const place =
		problem.entry === undefined
			? Option.fromUndefinedOr(problem.id).pipe(Option.map((id) => `${id}: `))
			: Option.some(
					problem.id === undefined
						? `entry ${problem.entry}: `
						: `entry ${problem.entry} (${problem.id}): `,
				)
	return `${Option.getOrElse(place, () => "")}${problem.reason}`
}

const describeAll = (problems: ReadonlyArray<Problem>) =>
	Arr.join(Arr.map(problems, describe), "; ")

/** The plugins file is not valid. Startup stops. */
export class PluginsFileInvalid extends Schema.TaggedError<
	PluginsFileInvalid,
	{ readonly brand: unique symbol }
>()("PluginsFileInvalid", {
	file: Schema.String,
	problems: Schema.Array(Problem),
}) {
	override get message() {
		return `The plugins file ${this.file} is not valid: ${describeAll(this.problems)}`
	}
}

/** OpenBot could not read the plugins file. Startup stops. */
export class PluginsFileUnreadable extends Schema.TaggedError<
	PluginsFileUnreadable,
	{ readonly brand: unique symbol }
>()("PluginsFileUnreadable", {
	file: Schema.String,
	/** The kind of the failure, such as `NotFound` or `PermissionDenied`. */
	reason: Schema.String,
	cause: Schema.Defect(),
}) {
	override get message() {
		return `OpenBot could not read the plugins file ${this.file} (${this.reason}).`
	}
}

/** An edit of the entries breaks a rule of the entries. */
export class EntriesInvalid extends Schema.TaggedError<
	EntriesInvalid,
	{ readonly brand: unique symbol }
>()("EntriesInvalid", { problems: Schema.Array(Problem) }) {
	override get message() {
		return `The plugin entries are not valid: ${describeAll(this.problems)}`
	}
}

export type LoadError = PluginsFileInvalid | PluginsFileUnreadable

/** What the rules know about the plugins. It is plain data, so the rules are pure. */
export interface Known {
	/** The entries before the file: `presetEntries`, or the entries of a test. */
	readonly base: ReadonlyArray<Entry.Entry>
	/** Every module name that the resolver has. No other plugin can run. */
	readonly bundled: ReadonlyArray<string>
	/** The ids that must be there and on. */
	readonly required: ReadonlyArray<string>
	/** The ids of `base` that take config. */
	readonly configurable: ReadonlyArray<string>
	/**
	 * The ids of `base` whose config can not use `!env`. Their config must be
	 * the same on every server, and the manifest hash has only the name of an
	 * environment variable, not its value.
	 */
	readonly noEnv?: ReadonlyArray<string>
}

/** What the rules know without test plugins. `openbot-inspect` uses it. */
export const presetKnown: Known = {
	base: presetEntries,
	bundled: Arr.map(Preset.ids, Preset.nameOf),
	required: Preset.required,
	configurable,
	noEnv: Preset.offByDefault,
}

// The tag is a copy of the one of the loader's `Include`. OpenBot does not use
// `Include`, because it writes the file back and can read it again.
const envTag: ScalarTag = {
	tag: "!env",
	identify: (value) => value instanceof Entry.Env,
	resolve: (name) => new Entry.Env({ name }),
	stringify: (item) => (item.value as Entry.Env).name,
}

const envName = /^[A-Z_][A-Z0-9_]*$/

const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> =>
	Predicate.isObject(value) &&
	!Arr.isArray(value) &&
	(Object.getPrototypeOf(value) === Object.prototype ||
		Object.getPrototypeOf(value) === null)

/** Every value inside a value, depth first. The value must have no cycle. */
const leaves = (value: unknown): ReadonlyArray<unknown> =>
	Arr.isArray(value)
		? Arr.flatMap(value, leaves)
		: isPlain(value)
			? Arr.flatMap(Rec.values(value), leaves)
			: [value]

/**
 * Turns the text of the file into raw entries. `!env NAME` becomes an
 * `Entry.Env` with the name only. An empty file gives no entries.
 */
export const parse = (
	text: string,
): Result.Result<ReadonlyArray<unknown>, ReadonlyArray<Problem>> => {
	const lineCounter = new LineCounter()
	const document = parseDocument(text, {
		customTags: [envTag],
		uniqueKeys: true,
		prettyErrors: false,
		lineCounter,
	})
	// A warning is a problem too: an unknown tag such as `!evn` would give a plain string.
	const notes = [...document.errors, ...document.warnings]
	if (Arr.isReadonlyArrayNonEmpty(notes))
		return Result.fail(
			Arr.map(notes, (note): Problem => {
				const at = lineCounter.linePos(note.pos[0])
				// The message of the note quotes the line of the file, which can hold a value.
				return {
					reason: `The YAML is not valid at line ${at.line}, column ${at.col} (${note.code}).`,
				}
			}),
		)
	return Result.try({
		try: (): unknown => document.toJS({ maxAliasCount: 100 }),
		// The message of the error can quote the file, so only its kind is kept.
		catch: (error): ReadonlyArray<Problem> => [
			{
				reason: `The YAML could not be read (${Predicate.hasProperty(error, "name") && Predicate.isString(error.name) ? error.name : "unknown"}).`,
			},
		],
	}).pipe(
		Result.flatMap(
			(value): Result.Result<ReadonlyArray<unknown>, ReadonlyArray<Problem>> =>
				value === null || value === undefined
					? Result.succeed([])
					: Arr.isArray(value)
						? Result.succeed(value)
						: Result.fail([{ reason: "The file must be a list of entries." }]),
		),
		Result.flatMap((list) =>
			Result.isFailure(Entry.checkAcyclic(list))
				? Result.fail([
						{ reason: "The file has an alias that points to itself." },
					])
				: Result.succeed(list),
		),
		Result.flatMap((list) =>
			Arr.some(
				leaves(list),
				(leaf) => leaf instanceof Entry.Env && !envName.test(leaf.name),
			)
				? Result.fail([
						{ reason: "!env needs the name of an environment variable." },
					])
				: Result.succeed(list),
		),
	)
}

/** The stable JSON text of a value: keys sorted, `Env` as `{"env": NAME}`. */
export const canonical = (value: unknown): string => {
	if (value instanceof Entry.Env) return canonical({ env: value.name })
	if (Arr.isArray(value)) return `[${Arr.join(Arr.map(value, canonical), ",")}]`
	if (
		value === null ||
		Predicate.isString(value) ||
		Predicate.isNumber(value) ||
		Predicate.isBoolean(value)
	)
		return JSON.stringify(value)
	if (isPlain(value))
		return `{${Arr.join(
			Arr.map(
				Arr.sort(
					Arr.filter(
						Rec.keys(value),
						(key) => !Predicate.isUndefined(value[key]),
					),
					Order.String,
				),
				(key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
			),
			",",
		)}}`
	return canonical({
		unsupported: Predicate.isObject(value)
			? (Object.getPrototypeOf(value)?.constructor?.name ?? "object")
			: typeof value,
	})
}

/** The same config, as the rules compare it. */
const sameConfig = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/**
 * The rules of the whole list of entries. The merge of the file and every
 * edit of the store check them:
 *
 * - an entry has only `id`, `name`, `disabled` and `config`;
 * - an entry of `base` keeps its name, and changes its config only when its
 *   plugin takes config;
 * - the config of an id in `noEnv` has no `!env`;
 * - a new entry names a bundled plugin that no other entry runs;
 * - every required plugin is there and on.
 *
 * Each problem has the id of its entry.
 */
export const checkEntries = (
	known: Known,
	entries: ReadonlyArray<Entry.Entry>,
): ReadonlyArray<Problem> => {
	const isBase = (id: string) => Arr.some(known.base, (base) => base.id === id)
	const ofEntry = Arr.flatMap(
		entries,
		(entry, index): ReadonlyArray<Problem> => {
			const id = entry.id
			const extra = Arr.map(
				Arr.filter(
					Rec.keys(entry),
					(key) => !Arr.contains(fields as ReadonlyArray<string>, key),
				),
				(key): Problem => ({
					id,
					reason: `The field "${key}" is not allowed here.`,
				}),
			)
			const rules = Option.match(
				Arr.findFirst(known.base, (base) => base.id === id),
				{
					onSome: (base): ReadonlyArray<Problem> => [
						...(entry.name === base.name
							? []
							: [
									{
										id,
										reason: "The name of a preset plugin can not change.",
									},
								]),
						...(Arr.contains(known.configurable, id) ||
						sameConfig(entry.config, base.config)
							? []
							: [{ id, reason: "This plugin takes no config." }]),
						...(Arr.contains(known.noEnv ?? [], id) &&
						Arr.some(leaves(entry.config), (leaf) => leaf instanceof Entry.Env)
							? [{ id, reason: "The config of this plugin can not use !env." }]
							: []),
					],
					onNone: (): ReadonlyArray<Problem> => {
						if (!Arr.contains(known.bundled, entry.name))
							return [
								{
									id,
									reason:
										"There is no plugin with this name in OpenBot. Only plugins that come with OpenBot can run.",
								},
							]
						// The entry of `base` keeps the plugin, or else the first entry that names it.
						const other = Arr.findFirst(
							entries,
							(other, at) =>
								at !== index &&
								other.name === entry.name &&
								(isBase(other.id) || at < index),
						)
						return Option.match(other, {
							onNone: () => [],
							onSome: (other) => [
								{
									id,
									reason: `The plugin already runs as entry "${other.id}". Change that entry.`,
								},
							],
						})
					},
				},
			)
			return [...extra, ...rules]
		},
	)
	const ofRequired = Arr.flatMap(known.required, (id): ReadonlyArray<Problem> =>
		Option.match(
			Arr.findFirst(entries, (entry) => entry.id === id),
			{
				onNone: () => [
					{ id, reason: "This plugin is needed, so it can not be removed." },
				],
				onSome: (entry) =>
					entry.disabled === true
						? [
								{
									id,
									reason: "This plugin is needed, so it can not be turned off.",
								},
							]
						: [],
			},
		),
	)
	return [...ofEntry, ...ofRequired]
}

/** One entry of the file after its own checks. */
interface Item {
	readonly position: number
	readonly id: string
	readonly name: Option.Option<string>
	readonly disabled: Option.Option<boolean>
	readonly config: Option.Option<unknown>
}

/** The checks of one entry of the file alone. */
const readItem = (
	raw: unknown,
	position: number,
): Result.Result<Item, ReadonlyArray<Problem>> => {
	if (!isPlain(raw))
		return Result.fail([
			{ entry: position, reason: "An entry must be a mapping with an id." },
		])
	const id = raw["id"]
	if (!Predicate.isString(id) || id === "")
		return Result.fail([{ entry: position, reason: "An entry needs an id." }])
	const at = { entry: position, id }
	const problems: ReadonlyArray<Problem> = [
		...Arr.map(
			Arr.filter(
				Rec.keys(raw),
				(key) => !Arr.contains(fields as ReadonlyArray<string>, key),
			),
			(key) => ({ ...at, reason: `The field "${key}" is not allowed here.` }),
		),
		...(Rec.has(raw, "disabled") && !Predicate.isBoolean(raw["disabled"])
			? [{ ...at, reason: '"disabled" must be true or false.' }]
			: []),
		...(Rec.has(raw, "name") && !Predicate.isString(raw["name"])
			? [{ ...at, reason: '"name" must be a string.' }]
			: []),
	]
	if (Arr.isReadonlyArrayNonEmpty(problems)) return Result.fail(problems)
	return Result.succeed({
		position,
		id,
		name: Option.liftPredicate(raw["name"], Predicate.isString),
		disabled: Option.liftPredicate(raw["disabled"], Predicate.isBoolean),
		config: Rec.has(raw, "config") ? Option.some(raw["config"]) : Option.none(),
	})
}

/**
 * The pure merge of the file into the entries of `base`. The entries of
 * `base` keep their order and take `disabled` and `config` from the file. The
 * new entries of the file come after them, in the order of the file. It
 * gives every problem at one time. It reads no environment and changes no
 * input.
 */
export const merge = (
	known: Known,
	overlay: ReadonlyArray<unknown>,
): Result.Result<ReadonlyArray<Entry.Entry>, ReadonlyArray<Problem>> => {
	const read = Arr.map(overlay, (raw, index) => readItem(raw, index + 1))
	const items = Arr.getSuccesses(read)
	const ownProblems = Arr.flatten(Arr.getFailures(read))
	// Every id of the file, also of entries with problems of their own.
	const ids = Arr.map(overlay, (raw) =>
		isPlain(raw) && Predicate.isString(raw["id"]) && raw["id"] !== ""
			? Option.some(raw["id"])
			: Option.none(),
	)
	const twice = Arr.flatMap(ids, (id, index): ReadonlyArray<Problem> =>
		Option.isSome(id) &&
		Arr.some(Arr.take(ids, index), (before) =>
			Option.exists(before, (before) => before === id.value),
		)
			? [
					{
						entry: index + 1,
						id: id.value,
						reason: "The id comes more than once in the file.",
					},
				]
			: [],
	)
	const isBase = (id: string) => Arr.some(known.base, (base) => base.id === id)
	const nameless = Arr.flatMap(items, (item): ReadonlyArray<Problem> =>
		!isBase(item.id) && Option.isNone(item.name)
			? [
					{
						entry: item.position,
						id: item.id,
						reason: "A new entry needs a name.",
					},
				]
			: [],
	)
	const first = (id: string) => Arr.findFirst(items, (item) => item.id === id)
	const patch = (entry: Entry.Entry, item: Item): Entry.Entry => ({
		...entry,
		...Option.match(item.name, {
			onNone: () => ({}),
			onSome: (name) => ({ name }),
		}),
		...Option.match(item.disabled, {
			onNone: () => ({}),
			onSome: (disabled) => ({ disabled }),
		}),
		...Option.match(item.config, {
			onNone: () => ({}),
			onSome: (config) => ({ config }),
		}),
	})
	const patched = Arr.map(known.base, (entry) =>
		Option.match(first(entry.id), {
			onNone: () => entry,
			onSome: (item) => patch(entry, item),
		}),
	)
	const added = Arr.flatMap(
		Arr.dedupeWith(
			Arr.filter(items, (item) => !isBase(item.id)),
			(a: Item, b: Item) => a.id === b.id,
		),
		(item: Item): ReadonlyArray<Entry.Entry> =>
			Option.match(item.name, {
				onNone: () => [],
				onSome: (name) => [patch({ id: item.id, name }, item)],
			}),
	)
	// Config alone does not turn on a plugin that is off at first.
	const stillOff = Arr.flatMap(items, (item): ReadonlyArray<Problem> =>
		Option.isSome(item.config) &&
		Option.isNone(item.disabled) &&
		Arr.some(
			known.base,
			(base) => base.id === item.id && base.disabled === true,
		)
			? [
					{
						entry: item.position,
						id: item.id,
						reason: 'This plugin is off. Add "disabled: false" to turn it on.',
					},
				]
			: [],
	)
	const merged = [...patched, ...added]
	const ofEntries = Arr.map(checkEntries(known, merged), (problem): Problem =>
		Option.match(Option.flatMap(Option.fromUndefinedOr(problem.id), first), {
			onNone: () => problem,
			onSome: (item) => ({ entry: item.position, ...problem }),
		}),
	)
	const problems = [
		...ownProblems,
		...twice,
		...nameless,
		...stillOff,
		...ofEntries,
	]
	if (Arr.isReadonlyArrayNonEmpty(problems)) return Result.fail(problems)
	return Result.mapError(Tree.validate(merged), (invalid) => [
		{ reason: `The entries are not valid: ${invalid.reason}` },
	])
}

/** Reads the file one time, then parses and merges it. */
export const load = (
	file: string,
	known: Known,
): Effect.Effect<
	ReadonlyArray<Entry.Entry>,
	LoadError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(file).pipe(
			Effect.mapError((cause) =>
				PluginsFileUnreadable.make({
					file,
					reason: cause.reason._tag,
					cause,
				}),
			),
		)
		return yield* Effect.fromResult(
			Result.flatMap(parse(text), (raw) => merge(known, raw)),
		).pipe(
			Effect.mapError((problems) =>
				PluginsFileInvalid.make({ file, problems }),
			),
		)
	})

/**
 * Logs why the file could not be used. The log of a failed start hides the
 * cause, so this line says what is wrong. It holds no value of the file.
 */
export const logFailure = (error: LoadError) =>
	error._tag === "PluginsFileInvalid"
		? Effect.logError("The plugins file is not valid.").pipe(
				Effect.annotateLogs({
					file: error.file,
					problems: Arr.map(error.problems, describe),
				}),
			)
		: Effect.logError("OpenBot could not read the plugins file.").pipe(
				Effect.annotateLogs({ file: error.file, reason: error.reason }),
			)

/** An entry as the hash sees it: `disabled` is always there. */
const normal = (entry: Entry.Entry) => ({
	id: entry.id,
	name: entry.name,
	disabled: entry.disabled === true,
	config: entry.config,
})

/**
 * `sha256:<hex>` of the stable form of the entries, in their order. The same
 * entries give the same hash on every node. The values of `!env` are not in
 * it, only their names.
 */
export const manifestHash = (entries: ReadonlyArray<Entry.Entry>) =>
	Effect.flatMap(Digest.Digest, (digest) =>
		digest.digestHex(
			Digest.sha256,
			new TextEncoder().encode(
				canonical({ version: 1, entries: Arr.map(entries, normal) }),
			),
		),
	).pipe(Effect.map((hex) => `sha256:${hex}`))

/**
 * Config as it may be shown: `Env` as `{"env": NAME}`, numbers, true, false
 * and null as they are, and every other value as `<redacted>`, because a
 * string can be a secret.
 */
const redact = (value: unknown): unknown => {
	if (value instanceof Entry.Env) return { env: value.name }
	if (Arr.isArray(value)) return Arr.map(value, redact)
	if (isPlain(value)) return Rec.map(value, redact)
	if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value))
		return value
	return "<redacted>"
}

/** One entry as it may be shown. */
export interface Shown {
	readonly id: string
	readonly name: string
	readonly disabled: boolean
	readonly config?: unknown
}

/** The entries as they may be shown, with the config redacted. */
export const show = (
	entries: ReadonlyArray<Entry.Entry>,
): ReadonlyArray<Shown> =>
	Arr.map(entries, (entry) => ({
		id: entry.id,
		name: entry.name,
		disabled: entry.disabled === true,
		...(entry.config === undefined ? {} : { config: redact(entry.config) }),
	}))

/** The ids that the file turned off, and the ids that it added. */
export const changes = (known: Known, entries: ReadonlyArray<Entry.Entry>) => {
	const baseIds = HashSet.fromIterable(Arr.map(known.base, (base) => base.id))
	return {
		off: Arr.filterMap(entries, (entry) =>
			entry.disabled === true ? Result.succeed(entry.id) : Result.failVoid,
		),
		added: Arr.filterMap(entries, (entry) =>
			HashSet.has(baseIds, entry.id)
				? Result.failVoid
				: Result.succeed(entry.id),
		),
	}
}
