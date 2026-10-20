import { RootProvider } from "fumadocs-ui/provider/next"
import "./global.css"
export const metadata = {
	// Set DOCS_URL to the public address of the docs site when you deploy it.
	metadataBase: new URL(process.env["DOCS_URL"] ?? "http://localhost:3000"),
	title: { template: "%s | OpenBot", default: "OpenBot" },
	description: "A headless, API-first Agent platform.",
}

export default function Layout({ children }: LayoutProps<"/">) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body className="flex flex-col min-h-screen">
				<RootProvider>{children}</RootProvider>
			</body>
		</html>
	)
}
