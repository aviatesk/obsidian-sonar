import type { App, TFile } from 'obsidian';
import { requestUrl } from 'obsidian';
import type { ConfigManager } from '../ConfigManager';
import { WithLogging } from '../WithLogging';
import type { Tool, ToolDefinition, ToolParameterSchema } from './Tool';

/**
 * Context object passed to extension tool scripts
 */
export interface ExtensionToolContext {
  app: App;
  vault: App['vault'];
  requestUrl: typeof requestUrl;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Expected export structure from extension tool scripts
 */
interface ExtensionToolExport {
  definition: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
  displayName: string;
  requiresPermission?: boolean;
  defaultDisabled?: boolean;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * Loads extension tools from JavaScript files in a vault folder
 */
export class ExtensionToolLoader extends WithLogging {
  protected readonly componentName = 'ExtensionToolLoader';

  constructor(
    private app: App,
    protected configManager: ConfigManager
  ) {
    super();
  }

  /**
   * Load all extension tools from the configured folder
   */
  async loadTools(): Promise<Tool[]> {
    const folderPath = this.configManager.get('extensionToolsPath');
    if (!folderPath) {
      return [];
    }

    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      this.warn(`Extension tools folder not found: ${folderPath}`);
      return [];
    }

    const files = this.app.vault.getFiles().filter(
      file =>
        file.path.startsWith(folderPath + '/') &&
        file.extension === 'js' &&
        !file.path.includes('/', folderPath.length + 1) // Only top-level files
    );

    if (files.length === 0) {
      this.log(`No .js files found in ${folderPath}`);
      return [];
    }

    const tools: Tool[] = [];
    for (const file of files) {
      const tool = await this.loadToolFromFile(file);
      if (tool) {
        tools.push(tool);
      }
    }

    this.log(`Loaded ${tools.length} extension tools from ${folderPath}`);
    return tools;
  }

  /**
   * Load a single tool from a JavaScript file
   */
  private async loadToolFromFile(file: TFile): Promise<Tool | null> {
    let content: string;
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (err) {
      this.warn(`Failed to read ${file.path}: ${err}`);
      return null;
    }

    const context = this.createContext(file.basename);

    let toolExport: ExtensionToolExport;
    try {
      toolExport = this.evaluateScript(content, context);
    } catch (err) {
      this.warn(`Failed to evaluate ${file.path}: ${err}`);
      return null;
    }

    if (!this.validateToolExport(toolExport, file.path)) {
      return null;
    }

    const tool: Tool = {
      definition: toolExport.definition as ToolDefinition,
      displayName: toolExport.displayName,
      isBuiltin: false,
      requiresPermission: toolExport.requiresPermission,
      defaultDisabled: toolExport.defaultDisabled,
      execute: async (args: Record<string, unknown>) => {
        try {
          return await toolExport.execute(args);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.error(`Tool ${toolExport.definition.name} failed: ${msg}`);
          return `Error: ${msg}`;
        }
      },
    };

    this.log(`Loaded tool: ${tool.definition.name} from ${file.path}`);
    return tool;
  }

  /**
   * Create the context object passed to extension scripts
   */
  private createContext(scriptName: string): ExtensionToolContext {
    const prefix = `[Sonar.Extension.${scriptName}]`;
    return {
      app: this.app,
      vault: this.app.vault,
      requestUrl,
      log: (msg: string) => console.log(`${prefix} ${msg}`),
      warn: (msg: string) => console.warn(`${prefix} ${msg}`),
      error: (msg: string) => console.error(`${prefix} ${msg}`),
    };
  }

  /**
   * Evaluate the script and extract the tool export
   */
  private evaluateScript(
    code: string,
    context: ExtensionToolContext
  ): ExtensionToolExport {
    // Create a function that wraps the script with module.exports pattern
    // The script should assign to module.exports or return from a factory function
    const wrappedCode = `
      const module = { exports: {} };
      const exports = module.exports;
      ${code}
      return typeof module.exports === 'function'
        ? module.exports(context)
        : module.exports;
    `;

    const factory = new Function('context', wrappedCode);
    return factory(context) as ExtensionToolExport;
  }

  /**
   * Validate that the exported object has the required structure
   */
  private validateToolExport(
    obj: unknown,
    filePath: string
  ): obj is ExtensionToolExport {
    if (!obj || typeof obj !== 'object') {
      this.warn(`${filePath}: Export must be an object`);
      return false;
    }

    const exp = obj as Record<string, unknown>;

    if (!exp.definition || typeof exp.definition !== 'object') {
      this.warn(`${filePath}: Missing or invalid 'definition'`);
      return false;
    }

    const def = exp.definition as Record<string, unknown>;
    if (typeof def.name !== 'string' || !def.name) {
      this.warn(`${filePath}: Missing 'definition.name'`);
      return false;
    }
    if (typeof def.description !== 'string') {
      this.warn(`${filePath}: Missing 'definition.description'`);
      return false;
    }
    if (!def.parameters || typeof def.parameters !== 'object') {
      this.warn(`${filePath}: Missing 'definition.parameters'`);
      return false;
    }

    if (typeof exp.displayName !== 'string' || !exp.displayName) {
      this.warn(`${filePath}: Missing 'displayName'`);
      return false;
    }

    if (typeof exp.execute !== 'function') {
      this.warn(`${filePath}: Missing 'execute' function`);
      return false;
    }

    return true;
  }
}
