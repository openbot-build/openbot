import { errors as executionErrors } from "./ExecutionsApi.ts"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { Required, own } from "./Authorization.ts"
import { chatParams } from "./ChatsApi.ts"

// tsdown drops star exports from the built API namespace. List the names here.
export {
	CodeRunId,
	maxCodeLength,
	Code,
	CallOutcome,
	CodeCall,
	FailureReason,
	CodeResult,
	CodeRunStatus,
	CodeRun,
	RequestCode,
	Output,
	ExecutionView,
} from "@openbot-build/domain/CodeRuns"
import { CodeRunId, ExecutionView } from "@openbot-build/domain/CodeRuns"

export const CodeRunsApi = HttpApiGroup.make("codeRuns").add(
	HttpApiEndpoint.get("get", "/v1/code-runs/:id", {
		params: { id: CodeRunId },
		success: ExecutionView,
		error: [...ExperienceErrors, ...executionErrors],
	}),
	HttpApiEndpoint.get("list", "/v1/chats/:chatId/code-runs", {
		params: chatParams,
		success: Schema.Array(ExecutionView),
		error: [...ExperienceErrors, ...executionErrors],
	}).annotate(Required, [own("read", "Chat", "chatId")]),
)
