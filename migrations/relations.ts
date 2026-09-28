import { relations } from "drizzle-orm/relations";
import { janusProjects, janusProjectShares, janusProjectArtifacts, familyAutomations, familyAutomationLogs, notionSyncConfig, notionCachedPages } from "./schema";

export const janusProjectSharesRelations = relations(janusProjectShares, ({one}) => ({
	janusProject: one(janusProjects, {
		fields: [janusProjectShares.projectId],
		references: [janusProjects.id]
	}),
}));

export const janusProjectsRelations = relations(janusProjects, ({many}) => ({
	janusProjectShares: many(janusProjectShares),
	janusProjectArtifacts: many(janusProjectArtifacts),
}));

export const janusProjectArtifactsRelations = relations(janusProjectArtifacts, ({one}) => ({
	janusProject: one(janusProjects, {
		fields: [janusProjectArtifacts.projectId],
		references: [janusProjects.id]
	}),
}));

export const familyAutomationLogsRelations = relations(familyAutomationLogs, ({one}) => ({
	familyAutomation: one(familyAutomations, {
		fields: [familyAutomationLogs.automationId],
		references: [familyAutomations.id]
	}),
}));

export const familyAutomationsRelations = relations(familyAutomations, ({many}) => ({
	familyAutomationLogs: many(familyAutomationLogs),
}));

export const notionCachedPagesRelations = relations(notionCachedPages, ({one}) => ({
	notionSyncConfig: one(notionSyncConfig, {
		fields: [notionCachedPages.syncConfigId],
		references: [notionSyncConfig.id]
	}),
}));

export const notionSyncConfigRelations = relations(notionSyncConfig, ({many}) => ({
	notionCachedPages: many(notionCachedPages),
}));