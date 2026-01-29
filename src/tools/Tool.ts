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
