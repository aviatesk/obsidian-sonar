import { App, Component, MarkdownRenderer as MR } from 'obsidian';
import type { Logger } from '../Logger';

export interface MarkdownRenderingOptions {
  maxLength?: number;
  cssClass: string;
  fallbackClass: string;
}

export class MarkdownRenderingManager {
  private components: Map<HTMLElement, Component> = new Map();
  private app: App;
  private options: MarkdownRenderingOptions;
  private logger: Logger;

  constructor(
    app: App,
    logger: Logger,
    options?: {
      maxLength?: number;
      cssClass?: string;
      fallbackClass?: string;
    }
  ) {
    this.app = app;
    this.logger = logger;
    this.options = {
      maxLength: undefined,
      cssClass: 'result-excerpt-markdown',
      fallbackClass: 'result-excerpt-fallback',
      ...options,
    };
  }

  /**
   * Clean up component for a specific element
   */
  cleanupElement(containerEl: HTMLElement): void {
    const component = this.components.get(containerEl);
    if (component) {
      component.unload();
      this.components.delete(containerEl);
    }
  }

  /**
   * Render markdown excerpt with proper component lifecycle management
   */
  async render(
    content: string,
    containerEl: HTMLElement,
    sourcePath: string
  ): Promise<void> {
    this.cleanupElement(containerEl);
    const excerpt = this.truncateContent(content, this.options.maxLength);
    try {
      const component = new Component();
      component.load();
      this.components.set(containerEl, component);
      await MR.render(this.app, excerpt, containerEl, sourcePath, component);
      containerEl.addClass(this.options.cssClass);
    } catch (err) {
      this.logger.error(`Failed to render markdown excerpt: ${err}`);
      containerEl.createEl('p', {
        text: excerpt,
        cls: this.options.fallbackClass,
      });
    }
  }

  /**
   * Truncate content intelligently at word boundaries
   */
  private truncateContent(
    content: string,
    maxLength: number | undefined
  ): string {
    if (maxLength === undefined || content.length <= maxLength) return content;
    let excerpt = content.substring(0, maxLength);
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
