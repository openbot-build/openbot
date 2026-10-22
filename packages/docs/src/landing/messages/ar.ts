import type { Messages } from "./types.ts"

export default {
	description: "منصة Agent بلا واجهة، تبدأ من الـ API.",
	nav: {
		label: "الموقع",
		docs: "الوثائق",
		api: "API",
		language: "اللغة",
	},
	hero: {
		title: ["Agents يمكنك استدعاؤها.", "نتائج يمكنك التحقق منها."],
		body: "OpenBot منصة Agent مفتوحة المصدر بلا واجهة مستخدم. تعطي العمل إلى Agent عبر HTTP.",
		quickStart: "بداية سريعة",
		apiReference: "مرجع الـ API",
		visual: "ابدأ Turn",
		prompt: "خطّط لرحلة ثلاثة أيام في روما.",
	},
	scenarios: {
		title: "ماذا ستبني؟",
		label: "العملاء",
		script: {
			label: "سكربت",
			prompt: "كل صباح، اقرأ تذاكر الدعم الجديدة ورتّبها.",
			meaning: "استدعِ نقطة نهاية واحدة من مهمة cron. اقرأ الجواب بصيغة JSON.",
		},
		service: {
			label: "خدمة",
			prompt: "افحص كل طلب جديد وضع علامة على الطلبات التي تبدو خاطئة.",
			meaning: "يبدأ خادمك Turn. ثم يقرأ بثًّا مباشرًا أو ينتظر باستطلاع طويل.",
		},
		bot: {
			label: "روبوت محادثة",
			prompt:
				"أجب عن الأسئلة في دردشة فريقنا. اسألني قبل أن ترسل بريدًا إلكترونيًا.",
			meaning: "استدعاءات الأدوات الخطرة تنتظر حتى يوافق شخص.",
		},
	},
	contract: {
		visual: "عقد واحد",
		title: ["كل ميزة هي استدعاء HTTP.", "عقد واحد بأنواع واضحة."],
		body: "الخادم وعميل TypeScript ومرجع الـ API كلها تأتي من عقد واحد. استخدم مفتاح API من أي برنامج.",
	},
	features: {
		title: ["استخدم عميلك الخاص.", "الناس يبقون في موقع التحكم."],
		items: [
			{
				title: "Sessions وTimelines",
				text: "يجري العمل داخل Sessions وTurns. تحفظ الـ Timeline النسخ، فتستطيع الرجوع والمحاولة من جديد.",
			},
			{
				title: "الموافقات",
				text: "استدعاءات الأدوات الخطرة تنتظر حتى يوافق شخص. كل جواب يحفظ سجله.",
			},
			{
				title: "Apps مفتوحة",
				text: "تجد الـ Agents وتستخدم Apps ينشرها الناشرون على الويب المفتوح عبر OpenBot App Protocol.",
			},
			{
				title: "نماذجك",
				text: "استخدم OpenAI أو Anthropic أو أي خادم يدعم Chat Completions.",
			},
		],
	},
	closing: {
		title: ["ابدأ في", "ثلاث خطوات."],
		label: "الخطوات",
		steps: [
			{
				title: "شغّل الخادم",
				text: "شغّل OpenBot على جهازك باستخدام Docker وdevenv. يأتي مع حساب تجريبي ونماذج تجريبية.",
			},
			{
				title: "أنشئ مفتاح API",
				text: "سجّل الدخول مرة واحدة في المتصفح، وأنشئ مفتاحًا، واستدعِ الـ API من أي برنامج.",
			},
			{
				title: "ابدأ Turn",
				text: "أرسل العمل بلغة بسيطة. اقرأ الجواب واستدعاءات الأدوات والسجل.",
			},
		],
	},
	license: {
		label: "الترخيص",
		body: "OpenBot برنامج حر تحت ترخيص AGPL-3.0-only. يمكنك قراءة الكود وتغييره وتشغيله على خوادمك.",
		link: "اقرأ الكود",
	},
} satisfies Messages
