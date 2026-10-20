import { Context } from "effect"

export interface Input {
	readonly text: string
	readonly productToken: string
	readonly url: string
}
export class Robots extends Context.Service<
	Robots,
	{
		readonly allowed: (input: Input) => boolean
	}
>()("@openbot-build/protocol/discovery/Robots") {}
