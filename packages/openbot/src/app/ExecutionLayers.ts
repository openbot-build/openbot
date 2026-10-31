import * as Artifacts from "../artifacts/Artifacts.ts"
import * as ArtifactFiles from "../artifacts/ArtifactFiles.ts"
import * as Materials from "../artifacts/Materials.ts"
import * as ComputerLifecycleWorkflow from "../computers/LifecycleWorkflow.ts"
import * as ComputerMaintenance from "../computers/Maintenance.ts"
import * as ComputerMaintenanceWorkflow from "../computers/MaintenanceWorkflow.ts"
import * as ConnectionWorkflow from "../apps/ConnectionWorkflow.ts"
import * as ImportedWorkflow from "../database/conversion/ImportedWorkflow.ts"
import * as TestCleanupWorkflow from "../apps/TestCleanupWorkflow.ts"
import * as GrantCleanupWorkflow from "../apps/GrantCleanupWorkflow.ts"
import * as TestWorkflow from "../apps/TestWorkflow.ts"
import * as ResetWorkflow from "../apps/ResetWorkflow.ts"
import * as AuthorizationWorkflow from "../apps/AuthorizationWorkflow.ts"
import * as FileWorkflows from "../files/FileWorkflows.ts"
import * as ArtifactWorkflow from "../artifacts/Workflow.ts"
import * as ProofWorkflow from "../apps/ProofWorkflow.ts"
import * as DeveloperMonitorWorkflow from "../apps/DeveloperMonitorWorkflow.ts"
import * as IndexRequestWorkflow from "../apps/IndexRequestWorkflow.ts"
import * as IndexWorkflow from "../apps/IndexWorkflow.ts"
import * as ChatControlWorkflow from "../chats/ChatControlWorkflow.ts"
import * as ChannelRemoval from "../channels/ChannelRemoval.ts"
import * as ChannelRemovalWorkflow from "../channels/ChannelRemovalWorkflow.ts"
import * as ChannelConfig from "../channels/ChannelConfig.ts"
import * as ChannelConfigWorkflow from "../channels/ChannelConfigWorkflow.ts"
import * as ChannelWorkflows from "../channels/ChannelWorkflows.ts"
import * as MemoryModels from "../bots/MemoryModels.ts"
import * as MemoryTasks from "../bots/MemoryTasks.ts"
import * as MemoryLearning from "../bots/MemoryLearning.ts"
import * as MemoryWorkflow from "../bots/MemoryWorkflow.ts"
import * as TriggerWorkflow from "../triggers/Workflow.ts"
import * as ReminderCommands from "../plugins/work/ReminderCommands.ts"
import * as ReminderWorkflow from "../plugins/work/ReminderWorkflow.ts"
import * as Views from "../apps/Views.ts"
import * as LiveConnections from "../chats/live/LiveConnections.ts"
import { Layer } from "effect"
import * as TurnWorkflow from "../chats/TurnWorkflow.ts"
import * as ToolWorkflow from "../chats/ToolWorkflow.ts"
import * as ToolNoticeWorkflow from "../chats/ToolNoticeWorkflow.ts"
import * as AppWorkflow from "../apps/AppWorkflow.ts"
import * as CodeWorkflow from "../code/CodeWorkflow.ts"
import * as RequestWorkflow from "../capabilities/RequestWorkflow.ts"
import * as RequestNoticeWorkflow from "../capabilities/RequestNoticeWorkflow.ts"
import * as DelegationWorkflow from "../bots/DelegationWorkflow.ts"
import * as DelegationNoticeWorkflow from "../bots/DelegationNoticeWorkflow.ts"
import * as TurnSession from "../chats/TurnSession.ts"
import * as ToolSession from "../chats/ToolSession.ts"
import * as TurnTools from "../chats/TurnTools.ts"
import * as ToolControls from "../chats/ToolControls.ts"
import * as ToolSteps from "../chats/ToolSteps.ts"
import * as ToolNotices from "../chats/ToolNotices.ts"
import * as ExecutionFeatures from "../chats/ExecutionFeatures.ts"
import * as AppCommands from "../apps/AppCommands.ts"
import * as AppSession from "../apps/AppSession.ts"
import * as AppApprovals from "../apps/AppApprovals.ts"
import * as CodeCommands from "../code/CodeCommands.ts"
import * as CodeProgram from "../code/CodeProgram.ts"
import * as Sandbox from "../code/Sandbox.ts"
import * as RequestCommands from "../capabilities/RequestCommands.ts"
import * as RequestReviews from "../capabilities/RequestReviews.ts"
import * as ReviewTools from "../capabilities/ReviewTools.ts"
import * as RequestNotices from "../capabilities/RequestNotices.ts"
import * as DelegationCommands from "../bots/DelegationCommands.ts"
import * as DelegationSession from "../bots/DelegationSession.ts"
import * as DelegationNotices from "../bots/DelegationNotices.ts"
import * as InputCommands from "../chats/InputCommands.ts"
import * as ToolCommands from "../chats/ToolCommands.ts"
import * as TurnAccess from "../chats/TurnAccess.ts"
import * as WorkAdmission from "../chats/WorkAdmission.ts"
import * as Calls from "../execution/Calls.ts"
import * as Runner from "../execution/Runner.ts"
import * as RunScope from "../execution/RunScope.ts"
import * as ActionPolicy from "../apps/ActionPolicy.ts"

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
	Layer.provideMerge(
		Artifacts.layer.pipe(
			Layer.provideMerge(Materials.layer),
			Layer.provideMerge(ArtifactFiles.layer),
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
	ArtifactWorkflow.layer,
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
