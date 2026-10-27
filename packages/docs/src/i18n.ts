// The languages of the site.
//
// The home page has every language in `homeLocales`. The docs have only the
// languages in `docsLocales`. English is the source for all text. English
// pages have no language prefix in the URL, and every other language has its
// own prefix, such as `/de/` or `/zh-cn/docs/`.

export interface HomeLocale {
	/** The first part of the URL path. Empty for English. */
	readonly path: string
	/** The BCP 47 language tag, for the `lang` attribute. */
	readonly lang: string
	/** The name of the language in that language. */
	readonly name: string
	readonly dir: "ltr" | "rtl"
}

export const homeLocales: ReadonlyArray<HomeLocale> = [
	{ path: "", lang: "en", name: "English", dir: "ltr" },
	{ path: "zh-cn", lang: "zh-CN", name: "简体中文", dir: "ltr" },
	{ path: "es", lang: "es", name: "Español", dir: "ltr" },
	{ path: "ar", lang: "ar", name: "العربية", dir: "rtl" },
	{ path: "hi", lang: "hi", name: "हिन्दी", dir: "ltr" },
	{ path: "pt", lang: "pt", name: "Português", dir: "ltr" },
	{ path: "fr", lang: "fr", name: "Français", dir: "ltr" },
	{ path: "id", lang: "id", name: "Bahasa Indonesia", dir: "ltr" },
	{ path: "ru", lang: "ru", name: "Русский", dir: "ltr" },
	{ path: "ja", lang: "ja", name: "日本語", dir: "ltr" },
	{ path: "de", lang: "de", name: "Deutsch", dir: "ltr" },
	{ path: "ko", lang: "ko", name: "한국어", dir: "ltr" },
	{ path: "it", lang: "it", name: "Italiano", dir: "ltr" },
	{ path: "tr", lang: "tr", name: "Türkçe", dir: "ltr" },
	{ path: "vi", lang: "vi", name: "Tiếng Việt", dir: "ltr" },
	{ path: "th", lang: "th", name: "ไทย", dir: "ltr" },
	{ path: "bn", lang: "bn", name: "বাংলা", dir: "ltr" },
	{ path: "ur", lang: "ur", name: "اردو", dir: "rtl" },
	{ path: "ms", lang: "ms", name: "Bahasa Melayu", dir: "ltr" },
	{ path: "tl", lang: "tl", name: "Filipino", dir: "ltr" },
	{ path: "fa", lang: "fa", name: "فارسی", dir: "rtl" },
	{ path: "mr", lang: "mr", name: "मराठी", dir: "ltr" },
	{ path: "jv", lang: "jv", name: "Basa Jawa", dir: "ltr" },
	{ path: "pcm", lang: "pcm", name: "Naijá", dir: "ltr" },
	{ path: "te", lang: "te", name: "తెలుగు", dir: "ltr" },
	{ path: "ta", lang: "ta", name: "தமிழ்", dir: "ltr" },
	{ path: "pl", lang: "pl", name: "Polski", dir: "ltr" },
	{ path: "lah", lang: "lah", name: "پنجابی", dir: "rtl" },
	{ path: "uk", lang: "uk", name: "Українська", dir: "ltr" },
	{ path: "ha", lang: "ha", name: "Hausa", dir: "ltr" },
	{ path: "gu", lang: "gu", name: "ગુજરાતી", dir: "ltr" },
	{ path: "sw", lang: "sw", name: "Kiswahili", dir: "ltr" },
	{ path: "kn", lang: "kn", name: "ಕನ್ನಡ", dir: "ltr" },
	{ path: "uz", lang: "uz", name: "O‘zbekcha", dir: "ltr" },
	{ path: "he", lang: "he", name: "עברית", dir: "rtl" },
]

/**
 * The docs languages, in the shape that Starlight wants. The key is the
 * folder in `content/docs` and the first part of the URL path.
 */
export const docsLocales = {
	root: { label: "English", lang: "en" },
	"zh-cn": { label: "简体中文", lang: "zh-CN" },
	de: { label: "Deutsch", lang: "de" },
} as const

/** The URL prefix of a language, such as `/de`. Empty for English. */
export const localePrefix = (path: string): string =>
	path === "" ? "" : `/${path}`

/**
 * The docs URL for a home page language. A language without docs links to
 * the English docs.
 */
export const docsPath = (path: string): string =>
	path in docsLocales ? `${localePrefix(path)}/docs/` : "/docs/"
