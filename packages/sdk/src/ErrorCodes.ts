export const ERROR_CODES = {
	sessionAwaitingAction: "session_awaiting_action",
	idempotencyKeyReused: "idempotency_key_reused",
	agentModelUnavailable: "agent_model_unavailable",
	automationReferenceUnavailable: "automation_reference_unavailable",
	automationScheduleUnusable: "automation_schedule_unusable",
	automationCapacityReached: "automation_capacity_reached",
	credentialUrlTaken: "credential_url_taken",
	mcpServerBlocked: "mcp_server_blocked",
	mcpServerCredentialInvalid: "mcp_server_credential_invalid",
	mcpServerCredentialsAmbiguous: "mcp_server_credentials_ambiguous",
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
