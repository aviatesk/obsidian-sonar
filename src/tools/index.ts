export type {
  Tool,
  ToolConfig,
  ToolDefinition,
  ToolParameterSchema,
  ToolPermissionRequest,
} from './Tool';
export { toOpenAIToolFormat } from './Tool';
export { ToolRegistry } from './ToolRegistry';

// Built-in tools
export {
  createSearchVaultTool,
  executeSearchVault,
  createReadFileTool,
  executeReadFile,
  createFetchUrlTool,
  executeFetchUrl,
  extractTextFromHtml,
  createEditNoteTool,
  executeEditNote,
} from './builtins';
export type {
  SearchVaultDependencies,
  ReadFileDependencies,
  FetchUrlDependencies,
  EditNoteDependencies,
} from './builtins';

// Extension tool loader
export { ExtensionToolLoader } from './ExtensionToolLoader';
export type {
  ExtensionToolContext,
  PluginResources,
} from './ExtensionToolLoader';
