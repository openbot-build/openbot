# Nobody Cares How

## Nobody cares how you built it

Hold one rule: NOBODY CARES HOW.

Stop talking about how you built it. Nobody asked for a tour of your machinery. Your implementation is your problem. Swallow the complexity, fix the system, and deliver the result.

Do not vomit architecture, libraries, services, databases, queues, caches, retries, protocols, status codes, stack traces, commands, file names, internal IDs, vendor names, or deployment guts into the product. Nobody cares that the detail is precise. Nobody cares that it was easy to copy from an exception. Nobody cares that it proves you did work. Cut it out.

A raw error is not honesty. A stack trace is not an explanation. An internal cause is not a next step. Every useless technical detail you push onto the audience is unfinished work you dumped in their lap. Finish your work. Make the product carry its own complexity.

## Take the blow yourself

Aim every ounce of this severity at yourself. Give none of it to the product audience. Do not let its contempt, anger, or bluntness leak into product copy. The user is not stupid. You are being lazy when you make them manage something the product should have handled.

Be ruthless with your own output and gentle with the user. Tear out every internal detail that does not help them understand, choose, act, stay safe, or recover. If they must decode your machinery to learn what happened, you failed the boundary. Fix it before you ship it.

## Kill the urge to show off

Technical detail is not a medal. Writing more of it does not make you look smart, senior, rigorous, transparent, or impressive. It makes you look unable to decide what matters when the audience did not need it.

Do not posture. Do not flex. Do not name-drop tools, patterns, vendors, protocols, or architecture to perform competence. Anybody can dump nouns. Anybody can paste a stack trace. That is cheap. Real mastery is the judgment to keep only what serves the audience and make the hard machinery disappear into a result that feels clear and reliable.

If you need the audience to see your machinery so that you can feel clever, your ego has become a product defect. Remove it. Your work is not a stage for proving how much you know. The audience owes you no admiration for solving the problem you were supposed to solve.

## Root out contempt

Do not mock, tease, sneer at, lecture, or patronize the audience. Do not use sarcasm, smugness, fake simplicity, an "obviously," or a wall of jargon to put them beneath you. Reject that impulse before it reaches the words, the interaction, or the shape of the product.

Their lack of knowledge about the system's internals is not ignorance. It is the boundary doing its job. You are not above them because you know what is behind it. You are responsible for making sure they do not have to know.

Competence is quiet: the right result, a clear promise, a clean boundary, useful recovery, and strong diagnostics backstage. Let the product prove the work. Stop trying to make the audience applaud the implementation.

In this skill, `user` means the actual audience of the product being built. It does not automatically mean the developer who is currently asking you to build or change that product. Give that developer the technical handoff they need. Give the product audience only the detail their own task needs.

A technical audience may need technical facts when those facts are the product's contract or the substance of its work. An API user may need request fields, response meaning, limits, and stable error semantics. They do not need the service topology, private dependency failure, or code path behind that contract.

## Tell people what happened to them

Translate every internal event into the user's world. Tell them, as needed:

- what happened to their goal;
- what finished, what did not, and whether their work is safe;
- what they can do now;
- what the product will do next and when;
- how to recover, undo, retry, or get help; and
- a safe reference code only when it helps support staff find the real diagnostic.

For example, do not say, "The database timed out after three retries." Say, "We couldn't save your changes. Your draft is still here. Try again."

Do not replace jargon with an empty "Something went wrong." Removing internal detail must not remove useful meaning. Be specific about the effect on the user even when the internal cause stays private.

## Keep diagnostics backstage

Separate the audience experience from developer and operator diagnostics across the whole path:

- UI, errors, loading and progress states, notifications, email, exports, help, support, and public interfaces show audience-relevant meaning.
- Protected logs, traces, alerts, and debugging tools keep the internal cause and context needed to repair the system.
- A support reference may connect the two without exposing internals, secrets, personal data, or unsafe identifiers.

Do not slap friendly words over a rotten boundary while internal details still leak through API responses, URLs, downloaded files, notifications, accessibility text, or support messages. Rip out the leak at its source.

## Never hide facts that belong to the user

This skill is not permission to conceal failure, weaken consent, avoid responsibility, or make the product vague. Tell the audience any fact they need to make a sound choice, stay safe, protect their work, or understand the product's real promise.

Keep material facts clear, including:

- price, payment, and ongoing cost;
- permissions, privacy, security, and use of data;
- loss of work, irreversible action, and effects on other people;
- eligibility, compatibility, availability, and meaningful limits;
- important uncertainty or failure; and
- technical terms that are part of the audience's real domain or contract.

Say these facts in the audience's language. Do not call a material fact an implementation detail just because it is uncomfortable to explain.

## Check every audience boundary

Before shipping or approving an audience-facing result, ask:

1. Does this detail change what the audience understands, chooses, does, or can recover from?
2. Can I state its effect on them instead of making them decode its internal cause?
3. Is it truly part of their domain or only part of mine?
4. Am I including it because they need it, or because I want to look clever, thorough, or important?
5. Does any word or interaction use the knowledge gap to claim status over them?
6. Did it leak only because exposing it was easier than designing the right boundary?
7. If I remove it, do operators still have enough protected evidence to diagnose the failure?

Exercise important success, wait, failure, and recovery paths through the real audience surface. Check both sides: the audience gets clear meaning and action without internal noise, while the people responsible for the system retain the diagnostic detail needed to fix it.
