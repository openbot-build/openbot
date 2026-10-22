import type { Messages } from "./types.ts"

export default {
	description: "פלטפורמת Agent בלי ממשק, שבנויה קודם כול סביב API.",
	nav: {
		label: "אתר",
		docs: "תיעוד",
		api: "API",
		language: "שפה",
	},
	hero: {
		title: ["Agents שאפשר לקרוא להם.", "תוצאות שאפשר לבדוק."],
		body: "OpenBot היא פלטפורמת Agent בקוד פתוח, בלי ממשק משתמש. אתם נותנים עבודה ל-Agent דרך HTTP.",
		quickStart: "התחלה מהירה",
		apiReference: "מדריך API",
		visual: "התחילו Turn",
		prompt: "תכנן שלושה ימים ברומא.",
	},
	scenarios: {
		title: "מה תבנו?",
		label: "לקוחות",
		script: {
			label: "סקריפט",
			prompt: "כל בוקר, קרא את פניות התמיכה החדשות ומיין אותן.",
			meaning:
				"קראו ל-endpoint אחד מתוך משימת cron (משימה שרצה לפי זמן). קראו את התשובה כ-JSON.",
		},
		service: {
			label: "שירות",
			prompt: "בדוק כל הזמנה חדשה וסמן את אלה שנראות לא תקינות.",
			meaning:
				"השרת שלכם מתחיל Turn. אחר כך הוא קורא stream או מחכה עם long poll.",
		},
		bot: {
			label: "צ׳אט בוט",
			prompt: "ענה על שאלות בצ׳אט של הצוות שלנו. שאל אותי לפני שאתה שולח מייל.",
			meaning: "קריאות כלים מסוכנות מחכות עד שאדם אומר כן.",
		},
	},
	contract: {
		visual: "חוזה אחד",
		title: ["כל פיצ׳ר הוא קריאת HTTP.", "חוזה אחד עם טיפוסים."],
		body: "השרת, לקוח ה-TypeScript ומדריך ה-API נוצרים כולם מחוזה אחד. השתמשו במפתח API מכל תוכנה.",
	},
	features: {
		title: ["הביאו לקוח משלכם.", "השליטה נשארת אצל אנשים."],
		items: [
			{
				title: "Sessions ו-Timelines",
				text: "העבודה קורית ב-Sessions וב-Turns. ה-Timeline שומר גרסאות, כך שאפשר לחזור אחורה ולנסות שוב.",
			},
			{
				title: "אישורים",
				text: "קריאות כלים מסוכנות מחכות עד שאדם אומר כן. כל תשובה שומרת את ההיסטוריה שלה.",
			},
			{
				title: "Apps פתוחות",
				text: "Agents מוצאים ומשתמשים ב-Apps שמפרסמים שמים ברשת הפתוחה עם OpenBot App Protocol.",
			},
			{
				title: "המודלים שלכם",
				text: "השתמשו ב-OpenAI, ב-Anthropic, או בכל שרת שמדבר Chat Completions.",
			},
		],
	},
	closing: {
		title: ["מתחילים", "בשלושה צעדים."],
		label: "צעדים",
		steps: [
			{
				title: "הפעילו את השרת",
				text: "הריצו את OpenBot במחשב שלכם עם Docker ו-devenv. הוא מגיע עם חשבון בדיקה ומודלים לבדיקה.",
			},
			{
				title: "צרו מפתח API",
				text: "התחברו פעם אחת בדפדפן, צרו מפתח, וקראו ל-API מכל תוכנה.",
			},
			{
				title: "התחילו Turn",
				text: "שלחו עבודה בשפה פשוטה. קראו את התשובה, את קריאות הכלים ואת ההיסטוריה.",
			},
		],
	},
	license: {
		label: "רישיון",
		body: "OpenBot היא תוכנה חופשית תחת AGPL-3.0-only. אפשר לקרוא את הקוד, לשנות אותו ולהריץ אותו על השרתים שלכם.",
		link: "לקוד",
	},
} satisfies Messages
