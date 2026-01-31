/**
 * Type definitions for Sonar extension tools
 *
 * Usage in your .ts file:
 * ```typescript
 * import type { ExtensionToolContext, ExtensionTool } from './types';
 *
 * export default function (ctx: ExtensionToolContext): ExtensionTool {
 *   return { ... };
 * }
 * ```
 */

import type { App, requestUrl } from 'obsidian';

/**
 * Plugin resources accessible from extension tools
 */
export interface PluginResources {
  /** Returns SearchManager instance or null if not ready */
  getSearchManager: () => unknown;
  /** Returns MetadataStore instance or null if not ready */
  getMetadataStore: () => unknown;
}

/**
 * Context object passed to extension tool factory functions
 */
export interface ExtensionToolContext {
  /** Obsidian App instance */
  app: App;
  /** Obsidian Vault instance */
  vault: App['vault'];
  /** Obsidian's requestUrl function for HTTP requests */
  requestUrl: typeof requestUrl;
  /** Log function (info level) */
  log: (message: string) => void;
  /** Warning function */
  warn: (message: string) => void;
  /** Error function */
  error: (message: string) => void;
  /** Plugin resources */
  plugin: PluginResources;
}

/**
 * Tool parameter schema (JSON Schema subset)
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
 * Extension tool definition
 */
export interface ExtensionTool {
  /** Tool definition for the LLM */
  definition: {
    /** Tool identifier (used by the LLM to call the tool) */
    name: string;
    /** Description shown to the LLM */
    description: string;
    /** JSON Schema for parameters */
    parameters: ToolParameterSchema;
  };
  /** Display name shown in UI */
  displayName: string;
  /** If true, requires user permission before execution */
  requiresPermission?: boolean;
  /** If true, disabled by default */
  defaultDisabled?: boolean;
  /** Execute function called when the tool is invoked */
  execute: (args: Record<string, unknown>) => Promise<string>;
  /** Returns reason if unavailable, undefined if available */
  getUnavailableReason?: () => string | undefined;
}
