import * as ComputerLifecycleWorkflow from "../plugin-computers/LifecycleWorkflow.ts"
import * as ComputerMaintenance from "../plugin-computers/Maintenance.ts"
import * as ComputerMaintenanceWorkflow from "../plugin-computers/MaintenanceWorkflow.ts"
import * as ConnectionWorkflow from "../plugin-apps/ConnectionWorkflow.ts"
import * as ImportedWorkflow from "../plugin-imported/ImportedWorkflow.ts"
import * as TestCleanupWorkflow from "../plugin-apps/TestCleanupWorkflow.ts"
import * as GrantCleanupWorkflow from "../plugin-apps/GrantCleanupWorkflow.ts"
import * as TestWorkflow from "../plugin-apps/TestWorkflow.ts"
import * as ResetWorkflow from "../plugin-apps/ResetWorkflow.ts"
import * as AuthorizationWorkflow from "../plugin-apps/AuthorizationWorkflow.ts"
import * as FileWorkflows from "../plugin-files/FileWorkflows.ts"
import * as ProofWorkflow from "../plugin-apps/ProofWorkflow.ts"
import * as DeveloperMonitorWorkflow from "../plugin-apps/DeveloperMonitorWorkflow.ts"
import * as IndexRequestWorkflow from "../plugin-apps/IndexRequestWorkflow.ts"
import * as IndexWorkflow from "../plugin-apps/IndexWorkflow.ts"
import * as ChatControlWorkflow from "../plugin-chats/ChatControlWorkflow.ts"
import * as ChannelRemoval from "../plugin-channels/ChannelRemoval.ts"
import * as ChannelRemovalWorkflow from "../plugin-channels/ChannelRemovalWorkflow.ts"
import * as ChannelConfig from "../plugin-channels/ChannelConfig.ts"
import * as ChannelConfigWorkflow from "../plugin-channels/ChannelConfigWorkflow.ts"
import * as ChannelWorkflows from "../plugin-channels/ChannelWorkflows.ts"
import * as MemoryModels from "../plugin-bots/MemoryModels.ts"
import * as MemoryTasks from "../plugin-bots/MemoryTasks.ts"
import * as MemoryLearning from "../plugin-bots/MemoryLearning.ts"
import * as MemoryWorkflow from "../plugin-bots/MemoryWorkflow.ts"
import * as TriggerWorkflow from "../plugin-triggers/Workflow.ts"
import * as ReminderCommands from "../plugin-work/ReminderCommands.ts"
import * as ReminderWorkflow from "../plugin-work/ReminderWorkflow.ts"
import * as Views from "../plugin-apps/Views.ts"
import * as LiveConnections from "../plugin-chats/live/LiveConnections.ts"
import { Layer } from "effect"
import * as TurnWorkflow from "../plugin-chats/TurnWorkflow.ts"
import * as ToolWorkflow from "../plugin-chats/ToolWorkflow.ts"
import * as ToolNoticeWorkflow from "../plugin-chats/ToolNoticeWorkflow.ts"
import * as AppWorkflow from "../plugin-apps/AppWorkflow.ts"
import * as CodeWorkflow from "../plugin-code/CodeWorkflow.ts"
import * as RequestWorkflow from "../plugin-capabilities/RequestWorkflow.ts"
import * as RequestNoticeWorkflow from "../plugin-capabilities/RequestNoticeWorkflow.ts"
import * as DelegationWorkflow from "../plugin-bots/DelegationWorkflow.ts"
import * as DelegationNoticeWorkflow from "../plugin-bots/DelegationNoticeWorkflow.ts"
import * as TurnSession from "../plugin-chats/TurnSession.ts"
import * as ToolSession from "../plugin-chats/ToolSession.ts"
import * as TurnTools from "../plugin-chats/TurnTools.ts"
import * as ToolControls from "../plugin-chats/ToolControls.ts"
import * as ToolSteps from "../plugin-chats/ToolSteps.ts"
import * as ToolNotices from "../plugin-chats/ToolNotices.ts"
import * as ExecutionFeatures from "../plugin-chats/ExecutionFeatures.ts"
import * as AppCommands from "../plugin-apps/AppCommands.ts"
import * as AppSession from "../plugin-apps/AppSession.ts"
import * as AppApprovals from "../plugin-apps/AppApprovals.ts"
import * as CodeCommands from "../plugin-code/CodeCommands.ts"
import * as CodeProgram from "../plugin-code/CodeProgram.ts"
import * as Sandbox from "../plugin-code/Sandbox.ts"
import * as RequestCommands from "../plugin-capabilities/RequestCommands.ts"
import * as RequestReviews from "../plugin-capabilities/RequestReviews.ts"
import * as ReviewTools from "../plugin-capabilities/ReviewTools.ts"
import * as RequestNotices from "../plugin-capabilities/RequestNotices.ts"
import * as DelegationCommands from "../plugin-bots/DelegationCommands.ts"
import * as DelegationSession from "../plugin-bots/DelegationSession.ts"
import * as DelegationNotices from "../plugin-bots/DelegationNotices.ts"
import * as InputCommands from "../plugin-chats/InputCommands.ts"
import * as ToolCommands from "../plugin-chats/ToolCommands.ts"
import * as TurnAccess from "../plugin-chats/TurnAccess.ts"
import * as WorkAdmission from "../plugin-chats/WorkAdmission.ts"
import * as Calls from "../server-execution/execution/Calls.ts"
import * as Runner from "../server-execution/execution/Runner.ts"
import * as RunScope from "../server-execution/execution/RunScope.ts"
import * as ActionPolicy from "../plugin-apps/ActionPolicy.ts"

/** One set of command services is shared by every product workflow. */
export const services = Layer.mergeAll(
	ComputerMaintenance.layer,
	ChannelConfig.layer,
	ChannelRemoval.layer,
	Views.layer,
	TurnSession.layer,
	ToolSession.layer,
	AppSession.layer,
	CodeProgram.layer,
	DelegationSession.layer,
	RequestReviews.layer,
	ToolNotices.layer,
	RequestNotices.layer,
	DelegationNotices.layer,
).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			ExecutionFeatures.layer,
			TurnTools.layer,
			ToolControls.layer,
			ReviewTools.layer,
			LiveConnections.layer,
		),
	),
	Layer.provideMerge(Layer.mergeAll(MemoryTasks.layer, MemoryLearning.layer)),
	Layer.provideMerge(MemoryModels.layer),
	Layer.provideMerge(
		Layer.mergeAll(
			DelegationCommands.layer,
			RequestCommands.layer,
			ReminderCommands.layer,
		),
	),
	Layer.provideMerge(
		Layer.mergeAll(
			AppCommands.layer,
			CodeCommands.layer,
			ToolSteps.layer,
			InputCommands.layer,
			ToolCommands.layer,
			AppApprovals.layer,
		),
	),
	Layer.provideMerge(
		Layer.mergeAll(
			TurnAccess.layer,
			WorkAdmission.layer,
			Calls.layer,
			Runner.layer,
			RunScope.layer,
		),
	),
	Layer.provide(Layer.merge(Sandbox.layer, ActionPolicy.layer)),
)

/** Registration is complete before the server accepts an execution command. */
export const workflows = Layer.mergeAll(
	ComputerLifecycleWorkflow.layer,
	ComputerMaintenanceWorkflow.layer,
	ImportedWorkflow.layer,
	GrantCleanupWorkflow.layer,
	TestWorkflow.layer,
	TestCleanupWorkflow.layer,
	AuthorizationWorkflow.layer,
	ConnectionWorkflow.layer,
	ResetWorkflow.layer,
	DeveloperMonitorWorkflow.layer,
	FileWorkflows.layer,
	ProofWorkflow.layer,
	IndexWorkflow.layer,
	IndexRequestWorkflow.layer,
	ChatControlWorkflow.layer,
	ChannelWorkflows.layer,
	ChannelConfigWorkflow.layer,
	ChannelRemovalWorkflow.layer,
	MemoryWorkflow.layer,
	TriggerWorkflow.layer,
	ReminderWorkflow.layer,
	TurnWorkflow.layer,
	ToolWorkflow.layer,
	ToolNoticeWorkflow.layer,
	AppWorkflow.layer,
	CodeWorkflow.layer,
	RequestWorkflow.layer,
	RequestNoticeWorkflow.layer,
	DelegationWorkflow.layer,
	DelegationNoticeWorkflow.layer,
)

export const layer = workflows.pipe(Layer.provideMerge(services))
