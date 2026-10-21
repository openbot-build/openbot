import type { APIRoute } from "astro"
// scripts/api.ts writes this file from the OpenBot API contract.
import document from "../../openapi.json"

// The OpenAPI document, so people and tools can download it.
export const GET: APIRoute = () =>
	new Response(JSON.stringify(document, null, 2) + "\n", {
		headers: { "Content-Type": "application/json" },
	})
