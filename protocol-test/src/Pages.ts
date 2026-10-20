import { HttpServerResponse } from "effect/http"
import { Match } from "effect"
import type { Consent } from "./Authorization.ts"
import { cardUrl, type Scenario } from "./Scenarios.ts"

/** The service puts the configured public origin here when it loads its view. */
export const originPlaceholder = "__PROTOCOL_TEST_PUBLIC_ORIGIN__"

export const escape = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
export const page =
	(title: string) =>
	(body: string, head = "") =>
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>${head}<style>*{box-sizing:border-box}html{font:100%/1.6 system-ui;color-scheme:light dark}body{max-width:64rem;margin:clamp(0rem,4vh,3rem) auto;padding:1rem;overflow-wrap:anywhere}h1{font-size:clamp(1.5rem,5vw,2rem);line-height:1.25}p{max-width:70ch}a{overflow-wrap:anywhere}pre{max-width:100%;max-height:24rem;overflow:auto;padding:1rem;background:#8882}form{width:100%;max-width:32rem}label{display:block;margin-block:1rem}button,input,textarea{font:inherit;max-width:100%}button{min-height:2.5rem;padding:.5rem 1rem;margin:.25rem 0;vertical-align:middle}input:not([type=radio]):not([type=checkbox]),textarea{display:block;width:100%;min-width:0;padding:.5rem}textarea{min-height:5rem;max-height:16rem;resize:vertical}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #8885;padding:.75rem;vertical-align:top}code{overflow-wrap:anywhere}fieldset{min-width:0;margin:1rem 0}.test-workspace{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,23rem),1fr));align-items:start;gap:1.5rem}.test-workspace fieldset{margin:0}.test-results{min-width:0}.test-results h2{margin-top:0;font-size:1.1rem}.test-results pre{margin-top:.5rem}.test-workspace+#documentation{display:inline-block;margin-top:1rem}</style></head><body>${body}</body></html>`

export const introduction = (origin: string) => (scenario: Scenario) =>
	page(scenario.title)(
		`<main><h1>${escape(scenario.title)}</h1><p>${escape(scenario.description)}</p><p>This is a public fixture to test that different systems work together. Use only made-up data. Test notes expire after 30 minutes. A restart deletes all grants and notes.</p><p><a href="/">All scenarios</a> · <a href="${cardUrl(origin)(scenario)}">Server Card</a> · <a href="/scenarios.json">Scenario matrix</a></p>${Match.value(
			scenario.authentication,
		).pipe(
			Match.when(
				{ kind: "anonymous" },
				() => "<p>No credentials are required.</p>",
			),
			Match.when(
				{ kind: "header" },
				(auth) =>
					`<p>Enter this public test header in the trusted credential field of the host:</p><pre>${escape(auth.name + ": " + auth.value)}</pre><p>These headers test transport compatibility. For standard MCP account authorization, use the OAuth scenarios.</p>`,
			),
			Match.when(
				{ kind: "oauth" },
				(auth) =>
					`<p>OAuth mode: <code>${auth.mode}</code>. Allow or deny access for the test account Alice or Bob. Available scopes: <code>test:read test:write</code>. Public test client: <code>protocol-test-public</code>. Confidential clients: <code>protocol-test-confidential-basic</code> and <code>protocol-test-confidential-post</code>; secret: <code>protocol-test-client-secret</code>. Client metadata: <a href="/clients/public.json">public client document</a>.</p>`,
			),
			Match.exhaustive,
		)}<h2>Try the connection</h2><p>Call <code>echo</code>, check <code>identity</code>, or call <code>read_workspace</code> with a new workspace ID. Use <code>write_note</code> with an idempotency key to test a temporary write and its App interface.</p></main>`,
		`<link rel="ai-catalog" type="application/ai-catalog+json" href="/apps/${scenario.id}/catalog.json">`,
	)

export const consentPage = (consent: Consent) =>
	page("Authorize test access")(
		`<main><h1>Authorize test access</h1><p><strong>${escape(consent.clientName)}</strong> requests access to <code>${escape(consent.resource)}</code>.</p><p>Scopes: ${escape(consent.scopes.join(", "))}. These public accounts hold made-up, temporary data.</p><form method="post" action="/consent"><input type="hidden" name="request" value="${escape(consent.id)}"><fieldset><legend>Test account</legend><label><input type="radio" name="account" value="alice" checked> Alice</label><label><input type="radio" name="account" value="bob"> Bob</label></fieldset><button type="submit" name="decision" value="allow">Allow test access</button><button type="submit" name="decision" value="deny">Deny access</button></form></main>`,
	)

export const html =
	(content: string) =>
	(options: HttpServerResponse.Options = {}) =>
		HttpServerResponse.text(content, { ...options, contentType: "text/html" })
