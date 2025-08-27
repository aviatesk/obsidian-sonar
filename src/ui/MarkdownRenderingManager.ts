import { App, Component, MarkdownRenderer as MR } from 'obsidian';

export interface MarkdownRenderingOptions {
  maxLength?: number;
  cssClass?: string;
  fallbackClass?: string;
}

export class MarkdownRenderingManager {
  private components: Map<HTMLElement, Component> = new Map();
  private app: App;
  private defaultOptions: Required<MarkdownRenderingOptions> = {
    maxLength: 1000,
    cssClass: 'markdown-rendered',
    fallbackClass: 'result-excerpt-fallback',
  };

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Render markdown excerpt with proper component lifecycle management
   */
  async render(
    content: string,
    containerEl: HTMLElement,
    sourcePath: string,
    options?: MarkdownRenderingOptions
  ): Promise<void> {
    const opts = { ...this.defaultOptions, ...options };
    const excerpt = this.truncateContent(content, opts.maxLength);
    try {
      const component = new Component();
      component.load();
      this.components.set(containerEl, component); // for clean up
      await MR.render(this.app, excerpt, containerEl, sourcePath, component);
      containerEl.addClass(opts.cssClass);
    } catch (error) {
      console.error('Failed to render markdown excerpt:', error);
      // Fallback to plain text
      containerEl.createEl('p', {
        text: excerpt,
        cls: opts.fallbackClass,
      });
    }
  }

  /**
   * Truncate content intelligently at word boundaries
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    let excerpt = content.substring(0, maxLength);
    // Find a "good" breakpoint to avoid cutting words or markdown syntax
    const lastSpace = excerpt.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.9) excerpt = excerpt.substring(0, lastSpace);
    return excerpt + '...';
  }

  /**
   * Clean up all components
   */
  cleanup(): void {
    for (const component of this.components.values()) {
      component.unload();
    }
    this.components.clear();
  }
}
