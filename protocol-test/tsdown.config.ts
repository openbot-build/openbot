import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { defineConfig } from "tsdown"
import config from "../tsdown.config.ts"
import { originPlaceholder, page } from "./src/Pages.ts"

export default defineConfig([
	{ ...config, entry: ["src/Main.ts"], dts: false, exports: false },
	{
		...config,
		entry: ["src/View.ts"],
		platform: "browser",
		unbundle: false,
		dts: false,
		exports: false,
		outDir: "dist/ui",
		deps: { alwaysBundle: /.*/, onlyBundle: false },
		outputOptions: { codeSplitting: false },
		hooks: {
			async "build:done"({ chunks }) {
				const script = chunks.find(
					(chunk) => chunk.type === "chunk" && chunk.isEntry,
				)
				if (script?.type !== "chunk")
					return Promise.reject(new Error("Missing MCP Apps bundle"))
				const body = `<main><h1>Protocol Test workspace</h1><p>Temporary synthetic data. Explicit controls exercise standard MCP Apps host requests.</p><p id="status" role="status" aria-live="polite">Connecting to the host.</p><div class="test-workspace"><fieldset id="controls" disabled><legend>Workspace actions</legend><form id="write" action="#" method="post"><label for="workspace">Workspace ID</label><input id="workspace" name="workspace" required pattern="(?:[a-zA-Z0-9_]|-){1,80}" value="demo" maxlength="80" autocapitalize="off" spellcheck="false"><label for="note">Synthetic note</label><textarea id="note" name="note" maxlength="4000" required></textarea><button type="submit">Write synthetic note</button></form><button id="read" type="button">Read with app-only tool</button><button id="resource" type="button">Read resource</button><button id="context" type="button">Update model context</button><button id="message" type="button">Send conversation message</button><button id="link" type="button">Open documentation</button><button id="fullscreen" type="button">Request fullscreen</button><button id="inline" type="button">Request inline mode</button><button id="resize" type="button">Report size</button></fieldset><section class="test-results" aria-labelledby="result-title"><h2 id="result-title">Tool result</h2><pre id="output" aria-label="Tool result">Run an action to see its result.</pre><details><summary>Host context</summary><pre id="host"></pre></details></section></div><a id="documentation" href="${originPlaceholder}/guide">Test guide</a></main><script type="module">${script.code.replaceAll("</script", "<\\/script")}</script>`
				await writeFile(
					join("dist", "ui.html"),
					page("Protocol Test workspace")(body),
				)
			},
		},
	},
])
