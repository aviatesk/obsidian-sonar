import { App, Modal, TFile, debounce, setIcon } from 'obsidian';
import { SearchResult } from '../core/search';
import { ObsidianEmbeddingSearch } from '../embeddingSearch';
import { SearchResultsComponent } from './SearchResultsComponent';
import { MarkdownRenderingManager } from './MarkdownRenderingManager';
import { ConfigManager } from '../ConfigManager';

export class SearchModal extends Modal {
  private embeddingSearch: ObsidianEmbeddingSearch;
  private configManager: ConfigManager;
  private resultsComponent: SearchResultsComponent;
  private markdownManager: MarkdownRenderingManager;
  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private debouncedSearch: () => void;
  private isSearching: boolean = false;
  private selectedIndex: number = -1;
  private resultItems: HTMLElement[] = [];

  constructor(
    app: App,
    embeddingSearch: ObsidianEmbeddingSearch,
    configManager: ConfigManager
  ) {
    super(app);
    this.embeddingSearch = embeddingSearch;
    this.configManager = configManager;
    this.resultsComponent = new SearchResultsComponent(app);
    this.markdownManager = new MarkdownRenderingManager(app);
    this.debouncedSearch = debounce(this.performSearch.bind(this), 1000, true);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('sonar-search-modal');
    contentEl.empty();

    // Modal container
    const modalContainer = contentEl.createDiv('sonar-modal-container');

    // Header section
    const headerEl = modalContainer.createDiv('sonar-modal-header');
    headerEl.createEl('h3', { text: 'Semantic search Notes' });

    // Search input container
    const searchContainer = modalContainer.createDiv('sonar-search-container');

    // Search icon
    const searchIcon = searchContainer.createDiv('sonar-search-icon');
    setIcon(searchIcon, 'search');

    // Input wrapper
    const inputWrapper = searchContainer.createDiv('sonar-input-wrapper');
    this.inputEl = inputWrapper.createEl('input', {
      type: 'text',
      placeholder: 'Type to semantic search notes...',
      cls: 'sonar-search-input',
    });

    // Clear button (initially hidden)
    const clearBtn = inputWrapper.createDiv('sonar-clear-btn');
    setIcon(clearBtn, 'x');
    clearBtn.style.display = 'none';
    clearBtn.addEventListener('click', () => {
      this.inputEl.value = '';
      this.inputEl.focus();
      clearBtn.style.display = 'none';
      this.resultsComponent.clearResults(
        this.resultsEl,
        'Type to semantic search notes'
      );
      this.updateStatus('');
    });

    // Status indicator
    this.statusEl = searchContainer.createDiv('sonar-search-status');

    // Results container
    this.resultsEl = modalContainer.createDiv('sonar-search-results');

    // Event listeners
    this.inputEl.addEventListener('input', () => {
      clearBtn.style.display = this.inputEl.value ? 'flex' : 'none';
      this.debouncedSearch();
    });

    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.inputEl.value) {
          this.inputEl.value = '';
          clearBtn.style.display = 'none';
          this.resultsComponent.clearResults(
            this.resultsEl,
            'Type to semantic search notes'
          );
          this.updateStatus('');
        } else {
          this.close();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.navigateResults(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.navigateResults(-1);
      } else if (e.key === 'Enter' && this.selectedIndex >= 0) {
        e.preventDefault();
        this.selectResult(this.selectedIndex);
      }
    });

    // Focus on input
    this.inputEl.focus();

    // Initial state
    this.updateStatus('');
    this.resultsComponent.clearResults(
      this.resultsEl,
      'Type to semantic search notes'
    );
  }

  private async performSearch(): Promise<void> {
    const query = this.inputEl.value.trim();

    if (!query) {
      this.resultsComponent.clearResults(
        this.resultsEl,
        'Type to semantic search notes'
      );
      this.updateStatus('');
      this.selectedIndex = -1;
      this.resultItems = [];
      return;
    }

    if (this.isSearching) {
      return;
    }

    this.isSearching = true;
    this.updateStatus('searching');

    try {
      const results = await this.embeddingSearch.search(
        query,
        this.configManager.get('topK')
      );
      this.displayResults(results);
      this.updateStatus(`${results.length} results`);
    } catch (error) {
      console.error('Search failed:', error);
      this.resultsComponent.clearResults(
        this.resultsEl,
        'Search failed. Please try again.'
      );
      this.updateStatus('error');
    } finally {
      this.isSearching = false;
    }
  }

  private displayResults(results: SearchResult[]): void {
    this.markdownManager.cleanup();
    this.resultsEl.empty();
    this.resultItems = [];
    this.selectedIndex = -1;

    if (results.length === 0) {
      const noResults = this.resultsEl.createDiv('sonar-no-results');
      noResults.createEl('p', {
        text: 'No results found',
        cls: 'sonar-no-results-text',
      });
      return;
    }

    const resultsList = this.resultsEl.createDiv('sonar-results-list');

    results.forEach((result, index) => {
      const resultItem = resultsList.createDiv('sonar-result-item');
      this.resultItems.push(resultItem);

      // Score indicator
      const scoreIndicator = resultItem.createDiv('sonar-score-indicator');
      const scorePercent = Math.round(result.score * 100);
      scoreIndicator.style.setProperty('--score-width', `${scorePercent}%`);

      // Main content
      const contentWrapper = resultItem.createDiv('sonar-result-content');

      // Title and path
      const titleRow = contentWrapper.createDiv('sonar-result-title-row');
      const displayTitle =
        result.metadata.title ||
        result.metadata.filePath.split('/').pop()?.replace('.md', '') ||
        'Untitled';

      titleRow.createEl('span', {
        text: displayTitle,
        cls: 'sonar-result-title',
      });

      // Score badge
      const scoreBadge = titleRow.createDiv('sonar-score-badge');
      scoreBadge.textContent = `${scorePercent}%`;

      // File path
      const pathEl = contentWrapper.createDiv('sonar-result-path');
      const pathIcon = pathEl.createDiv('sonar-path-icon');
      setIcon(pathIcon, 'file');
      pathEl.createEl('span', {
        text: result.metadata.filePath,
        cls: 'sonar-path-text',
      });

      // Excerpt
      if (result.content) {
        this.markdownManager.render(
          result.content,
          contentWrapper.createDiv('sonar-result-excerpt'),
          result.metadata.filePath,
          { maxLength: 1000 }
        );
      }

      // Click handler
      resultItem.addEventListener('click', () => {
        this.selectResult(index);
      });

      // Hover effect
      resultItem.addEventListener('mouseenter', () => {
        this.updateSelection(index);
      });
    });
  }

  private navigateResults(direction: number): void {
    if (this.resultItems.length === 0) return;

    const newIndex = this.selectedIndex + direction;
    if (newIndex >= 0 && newIndex < this.resultItems.length) {
      this.updateSelection(newIndex);
    }
  }

  private updateSelection(index: number): void {
    // Remove previous selection
    if (this.selectedIndex >= 0 && this.resultItems[this.selectedIndex]) {
      this.resultItems[this.selectedIndex].removeClass('selected');
    }

    // Add new selection
    this.selectedIndex = index;
    if (this.selectedIndex >= 0 && this.resultItems[this.selectedIndex]) {
      this.resultItems[this.selectedIndex].addClass('selected');
      this.resultItems[this.selectedIndex].scrollIntoView({
        block: 'nearest',
      });
    }
  }

  private async selectResult(index: number): Promise<void> {
    const results = this.resultsEl.querySelectorAll('.sonar-result-item');
    if (index >= 0 && index < results.length) {
      const result = results[index] as HTMLElement;
      const titleEl = result.querySelector('.sonar-result-title');
      if (titleEl) {
        const pathEl = result.querySelector('.sonar-path-text');
        if (pathEl) {
          const filePath = pathEl.textContent;
          if (filePath) {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
              // Don't close the modal, just open the file
              await this.app.workspace.getLeaf(false).openFile(file);
            }
          }
        }
      }
    }
  }

  private updateStatus(status: string): void {
    if (!this.statusEl) return;

    this.statusEl.empty();

    if (!status) {
      this.statusEl.style.display = 'none';
      return;
    }

    this.statusEl.style.display = 'flex';

    if (status === 'searching') {
      this.statusEl.createDiv('sonar-spinner');
      this.statusEl.createEl('span', {
        text: 'Searching...',
        cls: 'sonar-status-text',
      });
    } else if (status === 'error') {
      const errorIcon = this.statusEl.createDiv('sonar-status-icon error');
      setIcon(errorIcon, 'alert-circle');
      this.statusEl.createEl('span', {
        text: 'Search failed',
        cls: 'sonar-status-text error',
      });
    } else {
      this.statusEl.createEl('span', {
        text: status,
        cls: 'sonar-status-text',
      });
    }
  }

  onClose(): void {
    this.markdownManager.cleanup();
    const { contentEl } = this;
    contentEl.empty();
  }
}
