/**
 * JSON Schema for tool parameters
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean' | 'array';
      description: string;
      default?: unknown;
      items?: { type: string };
      enum?: string[];
    }
  >;
  required?: string[];
}

/**
 * Tool definition compatible with OpenAI function calling format
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/**
 * Tool with executable function
 */
export interface Tool {
  definition: ToolDefinition;
  displayName: string;
  isBuiltin: boolean;
  requiresPermission?: boolean;
  defaultDisabled?: boolean;
  execute: (args: Record<string, unknown>) => Promise<string>;
  /**
   * Returns the reason why the tool is unavailable, or undefined if available.
   */
  getUnavailableReason?: () => string | undefined;
}

/**
 * Permission request for a tool call
 */
export interface ToolPermissionRequest {
  toolName: string;
  displayName: string;
  args: Record<string, unknown>;
}

/**
 * Tool configuration for UI display
 */
export interface ToolConfig {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
  isBuiltin: boolean;
  /**
   * If set, the tool is unavailable and this is the reason.
   * Unavailable tools should be grayed out in the UI.
   */
  unavailableReason?: string;
}

/**
 * Convert Tool to OpenAI-compatible tool format for llama.cpp
 */
export function toOpenAIToolFormat(tool: Tool): {
  type: 'function';
  function: ToolDefinition;
} {
  return {
    type: 'function',
    function: tool.definition,
  };
}
