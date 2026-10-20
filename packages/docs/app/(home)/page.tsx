import Link from "next/link"

const features = [
	{
		title: "API first",
		text: "Every feature is an HTTP call, described by one typed contract.",
	},
	{
		title: "Bring your own client",
		text: "Use scripts, services, bots, or your own app. OpenBot has no UI of its own.",
	},
	{
		title: "People stay in control",
		text: "Risky tool calls wait for approval. Every answer keeps its history.",
	},
	{
		title: "Open Apps",
		text: "Agents find and use Apps that publishers put on the open web.",
	},
]

export default function HomePage() {
	return (
		<main className="flex flex-1 flex-col items-center px-4 py-16 text-center">
			<h1 className="mb-4 text-4xl font-bold">OpenBot</h1>
			<p className="mb-8 max-w-xl text-lg text-fd-muted-foreground">
				A headless, API-first Agent platform. Give work to an Agent over HTTP,
				and get back results you can check.
			</p>
			<div className="mb-12 flex flex-wrap justify-center gap-3">
				<Link
					href="/docs/quickstart"
					className="rounded-full bg-fd-primary px-5 py-2 font-medium text-fd-primary-foreground"
				>
					Quick start
				</Link>
				<Link
					href="/docs/api"
					className="rounded-full border px-5 py-2 font-medium"
				>
					API reference
				</Link>
			</div>
			<div className="grid w-full max-w-4xl gap-4 text-left sm:grid-cols-2">
				{features.map((feature) => (
					<div key={feature.title} className="rounded-xl border p-5">
						<h2 className="mb-1 font-semibold">{feature.title}</h2>
						<p className="text-sm text-fd-muted-foreground">{feature.text}</p>
					</div>
				))}
			</div>
		</main>
	)
}
