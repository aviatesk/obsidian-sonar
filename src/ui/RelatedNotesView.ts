import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownView,
  Notice,
  debounce,
} from 'obsidian';
import { ObsidianEmbeddingSearch } from '../embeddingSearch';
import { QueryProcessor, QueryOptions } from '../core/search';
import { SonarTokenizer } from '../core/tokenizer';
import { SearchResultsComponent } from './SearchResultsComponent';
import { ConfigManager } from '../ConfigManager';
import {
  SquareDashedMousePointer,
  BrainCircuit,
  RefreshCw,
  createElement,
} from 'lucide';

export const RELATED_NOTES_VIEW_TYPE = 'related-notes-view';

export class RelatedNotesView extends ItemView {
  private embeddingSearch: ObsidianEmbeddingSearch;
  private configManager: ConfigManager;
  private resultsComponent: SearchResultsComponent;
  private followCursor: boolean;
  private withExtraction: boolean;
  private isProcessing = false;
  private lastQuery = '';
  private lastActiveFile: TFile | null = null;
  private viewContentEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private debouncedRefresh: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    embeddingSearch: ObsidianEmbeddingSearch,
    configManager: ConfigManager
  ) {
    super(leaf);
    this.embeddingSearch = embeddingSearch;
    this.configManager = configManager;
    this.followCursor = configManager.get('followCursor');
    this.withExtraction = configManager.get('withExtraction');
    this.resultsComponent = new SearchResultsComponent(this.app);

    // Use trailing edge (false) for editor changes, configurable delay
    this.debouncedRefresh = debounce(
      this.refresh.bind(this),
      configManager.get('relatedNotesDebounceMs'),
      false // trailing edge - waits until after the delay
    );

    // Subscribe to config changes
    this.setupConfigListeners();
  }

  private setupConfigListeners(): void {
    // Recreate debounced function when delay changes
    this.configManager.subscribe('relatedNotesDebounceMs', (_, value) => {
      this.debouncedRefresh = debounce(
        this.refresh.bind(this),
        value,
        false // trailing edge
      );
    });

    // Refresh when relevant configs change
    this.configManager.subscribe('maxQueryTokens', () => {
      this.debouncedRefresh();
    });

    this.configManager.subscribe('embeddingModel', () => {
      this.debouncedRefresh();
    });

    this.configManager.subscribe('tokenizerModel', () => {
      this.debouncedRefresh();
    });

    // Update local state when config changes externally
    this.configManager.subscribe('followCursor', (_, value) => {
      this.followCursor = value;
      // Update UI if needed
      const btn = this.containerEl.querySelector('.follow-cursor-btn');
      if (btn) {
        btn.classList.toggle('active', value);
      }
    });

    this.configManager.subscribe('withExtraction', (_, value) => {
      this.withExtraction = value;
      // Update UI if needed
      const btn = this.containerEl.querySelector('.with-llm-extraction-btn');
      if (btn) {
        btn.classList.toggle('active', value);
      }
    });
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
    const followCursorIcon = createElement(SquareDashedMousePointer);
    followCursorIcon.setAttribute('width', '16');
    followCursorIcon.setAttribute('height', '16');
    followCursorBtn.appendChild(followCursorIcon);
    followCursorBtn.addEventListener('click', () => {
      this.followCursor = !this.followCursor;
      followCursorBtn.classList.toggle('active', this.followCursor);
      this.saveToggleSettings();
      this.refresh();
    });

    // With LLM Extraction toggle button
    const withExtractionBtn = controlsContainer.createEl('button', {
      cls: `icon-button with-llm-extraction-btn ${this.withExtraction ? 'active' : ''}`,
      attr: {
        'aria-label': 'With LLM extraction',
        title: 'Generate LLM extraction query',
      },
    });
    const brainIcon = createElement(BrainCircuit);
    brainIcon.setAttribute('width', '16');
    brainIcon.setAttribute('height', '16');
    withExtractionBtn.appendChild(brainIcon);
    withExtractionBtn.addEventListener('click', () => {
      this.withExtraction = !this.withExtraction;
      withExtractionBtn.classList.toggle('active', this.withExtraction);
      this.saveToggleSettings();
      this.refresh();
    });

    // Refresh button
    const refreshBtn = controlsContainer.createEl('button', {
      cls: 'icon-button refresh-button',
      attr: { 'aria-label': 'Refresh' },
    });
    const refreshIcon = createElement(RefreshCw);
    refreshIcon.setAttribute('width', '16');
    refreshIcon.setAttribute('height', '16');
    refreshBtn.appendChild(refreshIcon);
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
        this.debouncedRefresh();
      })
    );

    this.onActiveLeafChange();
  }

  private saveToggleSettings(): void {
    this.configManager.set('followCursor', this.followCursor);
    this.configManager.set('withExtraction', this.withExtraction);
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

      this.refresh();
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

      const options: QueryOptions = {
        fileName: activeFile.basename,
        cursorLine: cursorLine,
        followCursor: this.followCursor,
        withExtraction: this.withExtraction,
        maxTokens: this.configManager.get('maxQueryTokens'),
        embeddingModel: this.configManager.get('embeddingModel'),
        tokenizerModel: this.configManager.get('tokenizerModel') || undefined,
        ollamaUrl: this.configManager.get('ollamaUrl'),
        summaryModel: this.configManager.get('summaryModel'),
      };

      const query = await QueryProcessor.process(content, options);

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
        this.configManager.get('embeddingModel'),
        this.configManager.get('tokenizerModel') || undefined
      ).then(tokens => {
        queryLength.setText(SonarTokenizer.formatTokenCount(tokens));
      });

    try {
      const results = await this.embeddingSearch.search(
        query,
        this.configManager.get('topK')
      );
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
