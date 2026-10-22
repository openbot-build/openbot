interface Item {
	readonly title: string
	readonly text: string
}

interface Scenario {
	readonly label: string
	readonly prompt: string
	readonly meaning: string
}

// All the text of the home page in one language. Every language has a file
// in this folder with the name of its URL path, and `en.ts` is the source.
export interface Messages {
	readonly description: string
	readonly nav: {
		readonly label: string
		readonly docs: string
		readonly api: string
		readonly language: string
	}
	readonly hero: {
		readonly title: readonly [string, string]
		readonly body: string
		readonly quickStart: string
		readonly apiReference: string
		readonly visual: string
		/** The example work in the `curl` call. */
		readonly prompt: string
	}
	readonly scenarios: {
		readonly title: string
		readonly label: string
		readonly script: Scenario
		readonly service: Scenario
		readonly bot: Scenario
	}
	readonly contract: {
		readonly visual: string
		readonly title: readonly [string, string]
		readonly body: string
	}
	readonly features: {
		readonly title: readonly [string, string]
		readonly items: readonly [Item, Item, Item, Item]
	}
	readonly closing: {
		readonly title: readonly [string, string]
		readonly label: string
		readonly steps: readonly [Item, Item, Item]
	}
	readonly license: {
		readonly label: string
		readonly body: string
		readonly link: string
	}
}
