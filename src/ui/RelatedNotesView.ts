import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownView,
  Notice,
  debounce,
} from 'obsidian';
import { ObsidianEmbeddingSearch } from '../embeddingSearch';
import { QueryProcessor } from '../core/search';
import { SonarTokenizer } from '../core/tokenizer';
import { SearchResultsComponent } from './SearchResultsComponent';
import ObsidianSonarPlugin from '../../main';

export const RELATED_NOTES_VIEW_TYPE = 'related-notes-view';

export class RelatedNotesView extends ItemView {
  private plugin: ObsidianSonarPlugin;
  private embeddingSearch: ObsidianEmbeddingSearch;
  private queryProcessor: QueryProcessor;
  private resultsComponent: SearchResultsComponent;
  private followCursor: boolean = false;
  private withExtraction: boolean = false;
  private isProcessing = false;
  private lastQuery = '';
  private lastActiveFile: TFile | null = null;
  private viewContentEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private debouncedRefresh: () => void;
  private debouncedRefreshLong: () => void;
  private embeddingModel: string;
  private tokenizerModel?: string;
  private ollamaUrl: string;
  private summaryModel: string;
  private maxQueryTokens: number;

  constructor(
    plugin: ObsidianSonarPlugin,
    leaf: WorkspaceLeaf,
    embeddingSearch: ObsidianEmbeddingSearch,
    ollamaUrl: string,
    embeddingModel: string,
    summaryModel: string,
    maxQueryTokens: number = 128,
    tokenizerModel?: string,
    defaultFollowCursor: boolean = false,
    defaultwithExtraction: boolean = false
  ) {
    super(leaf);
    this.plugin = plugin;
    this.embeddingSearch = embeddingSearch;
    this.embeddingModel = embeddingModel;
    this.tokenizerModel = tokenizerModel;
    this.ollamaUrl = ollamaUrl;
    this.summaryModel = summaryModel;
    this.maxQueryTokens = maxQueryTokens;
    this.followCursor = defaultFollowCursor;
    this.withExtraction = defaultwithExtraction;
    this.queryProcessor = new QueryProcessor(
      maxQueryTokens,
      embeddingModel,
      tokenizerModel
    );
    this.resultsComponent = new SearchResultsComponent(this.app);

    this.debouncedRefresh = debounce(this.refresh.bind(this), 500, true);
    this.debouncedRefreshLong = debounce(this.refresh.bind(this), 10000, true);
  }

  getViewType(): string {
    return RELATED_NOTES_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Related Notes';
  }

  getIcon(): string {
    return 'links-coming-in';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('related-notes-view');

    this.headerEl = container.createDiv('related-notes-header');

    const statusContainer = this.headerEl.createDiv('status-container');
    this.statusEl = statusContainer.createDiv('status-indicator');
    this.updateStatus('Ready');

    const controlsContainer = statusContainer.createDiv('controls-container');

    // Follow Cursor toggle button
    const followCursorBtn = controlsContainer.createEl('button', {
      cls: `icon-button follow-cursor-btn ${this.followCursor ? 'active' : ''}`,
      attr: {
        'aria-label': 'Follow cursor',
        title: 'Follow cursor position',
      },
    });
    followCursorBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square-dashed-mouse-pointer">
                <path d="M5 3a2 2 0 0 0-2 2"></path>
                <path d="M19 3a2 2 0 0 1 2 2"></path>
                <path d="m12 12 4 10 1.7-4.3L22 16Z"></path>
                <path d="M5 21a2 2 0 0 1-2-2"></path>
                <path d="M9 3h1"></path>
                <path d="M9 21h1"></path>
                <path d="M14 3h1"></path>
                <path d="M3 9v1"></path>
                <path d="M21 9v1"></path>
                <path d="M3 14v1"></path>
            </svg>
        `;
    followCursorBtn.addEventListener('click', () => {
      this.followCursor = !this.followCursor;
      followCursorBtn.classList.toggle('active', this.followCursor);
      this.saveToggleSettings();
      this.debouncedRefresh();
    });

    // With LLM Extraction toggle button
    const withExtractionBtn = controlsContainer.createEl('button', {
      cls: `icon-button with-llm-extraction-btn ${this.withExtraction ? 'active' : ''}`,
      attr: {
        'aria-label': 'With LLM extraction',
        title: 'Generate LLM extraction query',
      },
    });
    withExtractionBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-brain-circuit">
                <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path>
                <path d="M9 13a4.5 4.5 0 0 0 3-4"></path>
                <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"></path>
                <path d="M3.477 10.896a4 4 0 0 1 .585-.396"></path>
                <path d="M6 18a4 4 0 0 1-1.967-.516"></path>
                <path d="M12 13h4"></path>
                <path d="M12 18h6a2 2 0 0 1 2 2v1"></path>
                <path d="M12 8h8"></path>
                <path d="M16 8v2a2 2 0 0 1-2 2"></path>
                <circle cx="16" cy="13" r=".5"></circle>
                <circle cx="18" cy="3" r=".5"></circle>
                <circle cx="20" cy="21" r=".5"></circle>
                <circle cx="20" cy="8" r=".5"></circle>
            </svg>
        `;
    withExtractionBtn.addEventListener('click', () => {
      this.withExtraction = !this.withExtraction;
      withExtractionBtn.classList.toggle('active', this.withExtraction);
      this.saveToggleSettings();
      // Use longer debounce for LLM extraction as it's more expensive
      if (this.withExtraction) {
        this.debouncedRefreshLong();
      } else {
        this.debouncedRefresh();
      }
    });

    // Refresh button
    const refreshBtn = controlsContainer.createEl('button', {
      cls: 'icon-button refresh-button',
      attr: { 'aria-label': 'Refresh' },
    });
    refreshBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                <path d="M21 3v5h-5"></path>
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                <path d="M3 21v-5h5"></path>
            </svg>
        `;
    refreshBtn.addEventListener('click', () => this.manualRefresh());

    this.viewContentEl = container.createDiv('related-notes-content');

    const queryContainer = this.viewContentEl.createDiv('current-query');
    const queryHeader = queryContainer.createDiv('query-header');
    queryHeader.createEl('h4', { text: 'Search Query' });
    queryHeader.createEl('span', {
      text: '0 tokens',
      cls: 'query-length',
    });
    const queryText = queryContainer.createDiv('query-text');
    queryText.setText('No selection');

    this.resultsEl = this.viewContentEl.createDiv('related-notes-results');

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', async () => {
        await this.onActiveLeafChange();
      })
    );

    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        if (this.followCursor) {
          this.debouncedRefresh();
        }
      })
    );

    this.onActiveLeafChange();
  }

  private saveToggleSettings(): void {
    const configManager = this.plugin.configManager;
    if (configManager) {
      configManager.set('followCursor', this.followCursor);
      configManager.set('withExtraction', this.withExtraction);
    }
  }

  private async onActiveLeafChange(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();

    // Check if file changed and is valid
    if (
      activeFile &&
      activeFile instanceof TFile &&
      activeFile !== this.lastActiveFile
    ) {
      this.lastActiveFile = activeFile;

      // Don't refresh in cursor mode on file change
      if (!this.followCursor) {
        if (this.withExtraction) {
          this.debouncedRefreshLong();
        } else {
          this.debouncedRefresh();
        }
      }
    } else if (!activeFile) {
      this.lastActiveFile = null;
      this.clearResults();
    }
  }

  private async refresh(): Promise<void> {
    if (this.isProcessing) return;

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !(activeFile instanceof TFile)) {
      this.clearResults();
      return;
    }

    this.isProcessing = true;
    this.updateStatus('Processing...');

    try {
      const content = await this.app.vault.cachedRead(activeFile);

      // Get cursor position if available
      let cursorLine = 0;
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView && activeView.editor) {
        const cursor = activeView.editor.getCursor();
        cursorLine = cursor.line;
      }

      const options = {
        fileName: activeFile.basename,
        cursorLine: cursorLine,
        followCursor: this.followCursor,
        withExtraction: this.withExtraction,
        maxTokens: this.maxQueryTokens,
        embeddingModel: this.embeddingModel,
        tokenizerModel: this.tokenizerModel,
        ollamaUrl: this.ollamaUrl,
        summaryModel: this.summaryModel,
      };

      const query = await this.queryProcessor.process(content, options);

      if (query && query !== this.lastQuery) {
        this.lastQuery = query;
        await this.triggerSearch(query);
      }
    } catch (error) {
      console.error('Error refreshing related notes:', error);
      new Notice('Failed to retrieve related notes');
    } finally {
      this.isProcessing = false;
      this.updateStatus('Ready');
    }
  }

  private async triggerSearch(query: string): Promise<void> {
    this.updateStatus('Searching...');

    const queryText = this.viewContentEl.querySelector('.query-text');
    const queryLength = this.viewContentEl.querySelector('.query-length');
    if (queryText) queryText.setText(query);
    if (queryLength)
      // Use async tokenizer for accurate count
      SonarTokenizer.estimateTokens(
        query,
        this.embeddingModel,
        this.tokenizerModel
      ).then(tokens => {
        queryLength.setText(SonarTokenizer.formatTokenCount(tokens));
      });

    try {
      const results = await this.embeddingSearch.search(query, 10);
      if (results.length === 0) {
        this.resultsComponent.clearResults(
          this.resultsEl,
          'No related notes found'
        );
      } else {
        this.resultsComponent.displayResults(this.resultsEl, results);
      }
    } catch (error) {
      console.error('Search failed:', error);
      new Notice('Search failed');
    }
  }

  private clearResults(): void {
    this.resultsComponent.clearResults(this.resultsEl, 'No active note');

    const queryText = this.viewContentEl.querySelector('.query-text');
    const queryLength = this.viewContentEl.querySelector('.query-length');
    if (queryText) {
      queryText.setText('No selection');
    }
    if (queryLength) {
      queryLength.setText('0 tokens');
    }
  }

  private updateStatus(status: string): void {
    if (this.statusEl) {
      this.statusEl.empty();

      if (
        status === 'Processing...' ||
        status === 'Searching...' ||
        status === 'Generating summary...'
      ) {
        this.statusEl.createEl('span', { cls: 'spinner' });
      }

      this.statusEl.createEl('span', { text: status });
    }
  }

  private manualRefresh(): void {
    if (this.isProcessing) {
      new Notice('Processing in progress. Please wait.');
      return;
    }
    this.refresh();
  }

  async onClose(): Promise<void> {}
}
