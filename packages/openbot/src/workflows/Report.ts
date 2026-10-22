import type { WorkflowsApi } from "@openbot-build/api"

const seconds = (result: WorkflowsApi.NodeResult) =>
	result.startedAt === null || result.finishedAt === null
		? 0
		: (result.finishedAt - result.startedAt) / 1000

const line = (text: string | null) =>
	(text ?? "").replaceAll("\n", " ").slice(0, 2000)

/** A short report of a Run in Markdown, for people and coding agents. */
export const markdown = (run: WorkflowsApi.Run) =>
	[
		`# ${run.name}`,
		"",
		`- Run: ${run.id}`,
		`- Status: ${run.status}`,
		`- Trigger: ${run.trigger}`,
		`- Revision: ${run.revision} of Workflow ${run.workflow}`,
		`- Nodes: ${run.summary.passed} passed, ${run.summary.failed} failed, ${run.summary.skipped} skipped`,
		`- Modes: ${run.summary.deterministic} deterministic, ${run.summary.live} live, ${run.summary.replayed} replayed, ${run.summary.handedOff} handed off`,
		`- Model tokens: ${run.usage.tokens}`,
		...(run.error === null ? [] : [`- Error: ${line(run.error)}`]),
		"",
		"## Nodes",
		"",
		"| Node | Kind | Needs | Status | Mode | Child Runs | Message |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		...run.nodes.map(
			(node) =>
				`| ${node.id} | ${node.kind} | ${node.needs.join(", ")} | ${node.status} | ${node.mode ?? ""} | ${node.children.join(", ")} | ${line(node.message).replaceAll("|", "\\|")} |`,
		),
		...(run.findings.length === 0
			? []
			: [
					"",
					"## Findings",
					...run.findings.flatMap((finding) => [
						"",
						`### [${finding.severity}] ${finding.title}`,
						"",
						`- Node: ${finding.node}`,
						`- Expected: ${line(finding.expected)}`,
						`- Observed: ${line(finding.observed)}`,
						"- Steps to show it again:",
						...finding.reproduction.map(
							(entry, index) => `  ${index + 1}. ${line(entry)}`,
						),
					]),
				]),
		"",
	].join("\n")

const xml = (text: string) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")

/** The Run as JUnit XML. Each node is one test case. A skipped node is a skipped test case. */
export const junit = (run: WorkflowsApi.Run) => {
	const total = run.nodes.reduce((all, node) => all + seconds(node), 0)
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<testsuites name="${xml(run.name)}" tests="${run.nodes.length}" failures="${run.summary.failed}" skipped="${run.summary.skipped}" time="${total}">`,
		`  <testsuite name="${xml(run.name)}" id="${xml(run.id)}" tests="${run.nodes.length}" failures="${run.summary.failed}" skipped="${run.summary.skipped}" time="${total}">`,
		...run.nodes.flatMap((step) => {
			const open = `    <testcase classname="${xml(run.name)}" name="${xml(step.id)}" time="${seconds(step)}">`
			if (step.status === "failed")
				return [
					open,
					`      <failure message="${xml(line(step.message))}" type="${xml(step.kind)}"/>`,
					"    </testcase>",
				]
			if (step.status === "skipped" || step.status === "pending")
				return [open, "      <skipped/>", "    </testcase>"]
			return [
				open,
				`      <system-out>${xml(`${step.kind} ${step.mode ?? ""}: ${line(step.message)}`)}</system-out>`,
				"    </testcase>",
			]
		}),
		"  </testsuite>",
		"</testsuites>",
		"",
	].join("\n")
}
