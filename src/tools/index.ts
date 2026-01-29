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
  createWebSearchTool,
  executeWebSearch,
  createFetchUrlTool,
  executeFetchUrl,
  extractTextFromHtml,
  createEditNoteTool,
  executeEditNote,
} from './builtins';
export type {
  SearchVaultDependencies,
  ReadFileDependencies,
  WebSearchDependencies,
  EditNoteDependencies,
} from './builtins';

// Extension tool loader
export { ExtensionToolLoader } from './ExtensionToolLoader';
export type { ExtensionToolContext } from './ExtensionToolLoader';
