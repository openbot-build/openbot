import { defineRouteMiddleware } from "@astrojs/starlight/route-data"

export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute
	route.siteTitleHref = "https://openbot.build/"

	if (!/^\/api(?:\/|$)/.test(context.url.pathname)) return

	// Starlight adds links for every language, but starlight-openapi builds
	// only the English API pages. Keep links to pages that exist.
	route.head = route.head.filter(
		(item) =>
			item.tag !== "link" ||
			item.attrs?.["rel"] !== "alternate" ||
			item.attrs?.["hreflang"] === "en" ||
			item.attrs?.["hreflang"] === "x-default",
	)
})
