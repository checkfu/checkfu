import type { Context } from "@earendil-works/chord/context"
import type { NestedToolExecutionResult, ToolExecutionApi } from "@earendil-works/pi-durable"

type ExecuteTool = ToolExecutionApi["executeTool"]

export const asExecuteTool = (
	executeTool: (
		name: string,
		args: Parameters<ExecuteTool>[1],
		context: Context,
		options?: { readonly key?: string; readonly progress?: boolean },
	) => Promise<NestedToolExecutionResult>,
): ExecuteTool => executeTool as ExecuteTool
