import { Schema } from "effect"

export const Check = Schema.TaggedUnion({
	Pending: {},
	Indexed: { attemptedAt: Schema.Finite },
	Excluded: { attemptedAt: Schema.Finite, reason: Schema.String },
	Withdrawn: { attemptedAt: Schema.Finite, reason: Schema.String },
	Unconfirmed: { attemptedAt: Schema.Finite, reason: Schema.String },
	Failed: { attemptedAt: Schema.Finite, reason: Schema.String },
})
export type Check = typeof Check.Type
/** The status of index work after OpenBot accepts an index request. */
export const JobStatus = Schema.Literals(["Waiting", "Verifying", "Completed"])
export type JobStatus = typeof JobStatus.Type

/** The saved result of one check. HTTP views add their own access details. */
export const Job = Schema.Struct({
	cardUrl: Schema.String,
	generation: Schema.String,
	status: JobStatus,
	check: Schema.NullOr(Check),
	requestedAt: Schema.Finite,
})
export type Job = typeof Job.Type

/** The platform can block one App and give the publisher a way to appeal. */
export const Restriction = Schema.Struct({
	cardUrl: Schema.String,
	reason: Schema.NonEmptyString,
	appealUrl: Schema.String,
})
export type Restriction = typeof Restriction.Type
export class AppRestricted extends Schema.TaggedError<
	AppRestricted,
	{ readonly brand: unique symbol }
>()("AppRestricted", { restriction: Restriction }) {}

export const Source = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	url: Schema.String,
	simulated: Schema.Boolean,
})
export type Source = typeof Source.Type

export const SourceIssue = Schema.Struct({
	source: Schema.NonEmptyString,
	message: Schema.String,
})
export type SourceIssue = typeof SourceIssue.Type
export const Match = Schema.Literals(["name", "description", "publisher"])

/** A query has numbers after its transport has read the input. */
export const Query = Schema.Struct({
	query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
	source: Schema.optionalKey(Schema.NonEmptyString),
	cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
	limit: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
	),
})
export type Query = typeof Query.Type

export class IndexInputInvalid extends Schema.TaggedError<
	IndexInputInvalid,
	{ readonly brand: unique symbol }
>()("IndexInputInvalid", { message: Schema.String }) {}
export class IndexUnavailable extends Schema.TaggedError<
	IndexUnavailable,
	{ readonly brand: unique symbol }
>()("IndexUnavailable", { issues: Schema.Array(SourceIssue) }) {}
export class IndexNotFound extends Schema.TaggedError<
	IndexNotFound,
	{ readonly brand: unique symbol }
>()("IndexNotFound", { message: Schema.String }) {}
export class IndexRestricted extends Schema.TaggedError<
	IndexRestricted,
	{ readonly brand: unique symbol }
>()("IndexRestricted", { restriction: Restriction }) {}
