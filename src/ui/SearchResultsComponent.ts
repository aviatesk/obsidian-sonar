import { App, TFile } from 'obsidian';
import { SearchResult } from '../core/search';
import { MarkdownRenderingManager } from './MarkdownRenderingManager';

export class SearchResultsComponent {
  private app: App;
  private markdownManager: MarkdownRenderingManager;

  constructor(app: App) {
    this.app = app;
    this.markdownManager = new MarkdownRenderingManager(app);
  }

  displayResults(
    containerEl: HTMLElement,
    results: SearchResult[],
    onFileClick?: (file: TFile) => void
  ): void {
    this.markdownManager.cleanup();
    containerEl.empty();

    if (results.length === 0) {
      containerEl.createEl('p', {
        text: 'No results found',
        cls: 'no-results',
      });
      return;
    }

    const resultsList = containerEl.createEl('div', {
      cls: 'results-list',
    });

    results.forEach((result, _index) => {
      const resultItem = resultsList.createDiv('result-item');

      const scoreBar = resultItem.createDiv('score-bar');
      const scoreValue = Math.round(result.score * 100);
      scoreBar.style.width = `${scoreValue}%`;
      scoreBar.setAttribute('data-score', `${scoreValue}%`);

      const titleContainer = resultItem.createDiv('title-container');
      // Use filename from path if title is not available
      const displayTitle =
        result.metadata.title ||
        result.metadata.filePath.split('/').pop()?.replace('.md', '') ||
        'Untitled';
      const title = titleContainer.createEl('h5', {
        text: displayTitle,
        cls: 'result-title',
      });
      titleContainer.createEl('span', {
        text: `${result.score.toFixed(3)}`,
        cls: 'result-score',
      });

      title.addEventListener('click', async () => {
        const file = this.app.vault.getAbstractFileByPath(
          result.metadata.filePath
        );
        if (file instanceof TFile) {
          if (onFileClick) {
            onFileClick(file);
          } else {
            await this.app.workspace.getLeaf(false).openFile(file);
          }
        }
      });

      resultItem.createEl('div', {
        text: result.metadata.filePath,
        cls: 'result-path',
      });

      if (result.metadata.headings && result.metadata.headings.length > 0) {
        resultItem.createEl('div', {
          text: '📍 ' + result.metadata.headings.join(' > '),
          cls: 'result-headings',
        });
      }

      this.markdownManager.render(
        result.content,
        resultItem.createDiv('result-excerpt'),
        result.metadata.filePath,
        { maxLength: 1000 }
      );
    });
  }

  clearResults(
    containerEl: HTMLElement,
    message: string = 'No results found'
  ): void {
    this.markdownManager.cleanup();
    containerEl.empty();
    containerEl.createEl('p', {
      text: message,
      cls: 'no-results',
    });
  }
}
