import { constants } from "node:os"
import {
	Array as Arr,
	Option,
	type PlatformError,
	Predicate,
	pipe,
	Record as Rec,
	String as Str,
} from "effect"

const isSignal = (name: string): name is NodeJS.Signals =>
	Rec.has<string, number>(constants.signals, name)

/**
 * The signal that stopped a program, if a signal stopped it.
 *
 * The handle of @effect/platform-node 4.0.6 gives no signal when a program stops on
 * a signal. Its `exitCode` fails with an error whose cause names the signal in its
 * text, so this reads the signal from that text.
 */
export const signalOf = (
	error: PlatformError.PlatformError,
): Option.Option<NodeJS.Signals> =>
	pipe(
		Option.liftPredicate(error.reason.cause, Predicate.isError),
		Option.flatMap((cause) =>
			Str.match(/signal: '(SIG[A-Z0-9]+)'/)(cause.message),
		),
		Option.flatMap(Arr.get(1)),
		Option.filter(isSignal),
	)
