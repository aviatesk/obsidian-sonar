import type { Tool, ToolConfig } from './Tool';
import { toOpenAIToolFormat } from './Tool';

/**
 * Registry for managing built-in and extension tools
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private enabledTools: Set<string> = new Set();

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
    // Enable by default unless defaultDisabled is set
    if (!tool.defaultDisabled) {
      this.enabledTools.add(tool.definition.name);
    }
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): void {
    this.tools.delete(name);
    this.enabledTools.delete(name);
  }

  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is enabled
   */
  isEnabled(name: string): boolean {
    return this.enabledTools.has(name);
  }

  /**
   * Enable a tool
   */
  enable(name: string): void {
    if (this.tools.has(name)) {
      this.enabledTools.add(name);
    }
  }

  /**
   * Disable a tool
   */
  disable(name: string): void {
    this.enabledTools.delete(name);
  }

  /**
   * Toggle a tool's enabled state
   */
  toggle(name: string): boolean {
    if (this.isEnabled(name)) {
      this.disable(name);
      return false;
    } else {
      this.enable(name);
      return true;
    }
  }

  /**
   * Get all registered tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all enabled and available tools
   */
  getEnabled(): Tool[] {
    return this.getAll().filter(
      tool =>
        this.isEnabled(tool.definition.name) && tool.isAvailable?.() === null
    );
  }

  /**
   * Get tool configurations for UI display
   */
  getToolConfigs(): ToolConfig[] {
    return this.getAll().map(tool => ({
      name: tool.definition.name,
      displayName: tool.displayName,
      description: tool.definition.description,
      enabled: this.isEnabled(tool.definition.name),
      isBuiltin: tool.isBuiltin,
      unavailableReason: tool.isAvailable?.() ?? undefined,
    }));
  }

  /**
   * Get enabled tools in OpenAI-compatible format for llama.cpp
   */
  getOpenAITools(): Array<{ type: 'function'; function: Tool['definition'] }> {
    return this.getEnabled().map(toOpenAIToolFormat);
  }

  /**
   * Check if a tool requires permission before execution
   */
  requiresPermission(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.requiresPermission ?? false;
  }

  /**
   * Execute a tool by name
   */
  async execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<string | null> {
    const tool = this.tools.get(name);
    if (!tool) {
      return null;
    }
    try {
      return await tool.execute(args);
    } catch (error) {
      return `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Unregister all extension tools (non-builtin)
   */
  unregisterExtensionTools(): void {
    for (const [name, tool] of this.tools) {
      if (!tool.isBuiltin) {
        this.unregister(name);
      }
    }
  }

  /**
   * Get extension tools (non-builtin)
   */
  getExtensionTools(): Tool[] {
    return this.getAll().filter(tool => !tool.isBuiltin);
  }
}
