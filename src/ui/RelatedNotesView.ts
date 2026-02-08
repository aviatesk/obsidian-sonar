import {
  HoverPopover,
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownView,
  Notice,
  debounce,
} from 'obsidian';
import type { MarkdownPostProcessorContext } from 'obsidian';
import type { PdfView, TextItem } from '../pdfjs';
import { normalizeText } from '../pdfExtractor';
import { EditorView } from '@codemirror/view';
import { mount, unmount } from 'svelte';
import { writable, get } from 'svelte/store';
import {
  sonarState,
  isSearchReady,
  isRerankerReady,
  type SonarModelState,
} from '../SonarState';
import type { SearchResult } from '../SearchManager';
import { processQuery, type QueryOptions } from '../QueryProcessor';
import { ConfigManager } from '../ConfigManager';
import { getCurrentContext } from '../obsidian-utils';
import { createComponentLogger, type ComponentLogger } from '../WithLogging';
import { truncateQuery, formatDuration } from '../utils';
import RelatedNotesContent from './RelatedNotesContent.svelte';
import type SonarPlugin from '../../main';
import { isAudioExtension } from '../audio';

export const RELATED_NOTES_VIEW_TYPE = 'related-notes-view';

export type RelatedNotesStatus =
  | 'initializing'
  | 'initialization-failed'
  | 'no-active-note'
  | 'processing'
  | 'unable-to-determine-position'
  | 'ready'
  | 'no-content'
  | 'error';

export const STATUS_DISPLAY_TEXT: Record<RelatedNotesStatus, string> = {
  initializing: 'Initializing...',
  'initialization-failed': 'Initialization failed',
  'no-active-note': 'No active note',
  processing: 'Processing...',
  'unable-to-determine-position': 'Unable to determine position',
  ready: 'Ready to search',
  'no-content': 'No content to search',
  error: 'Failed to search',
};

export type QueryMode = 'default' | 'editing';

interface RelatedNotesState {
  query: string;
  results: SearchResult[];
  tokenCount: number;
  status: RelatedNotesStatus;
  activeFile: string | null;
  isReranking: boolean;
  queryMode: QueryMode;
}

const EMPTY_STATE_BASE: Omit<RelatedNotesState, 'status' | 'queryMode'> = {
  query: '',
  results: [],
  tokenCount: 0,
  activeFile: null,
  isReranking: false,
};

const COMPONENT_ID = 'RelatedNotesView';

export class RelatedNotesView extends ItemView {
  private plugin: SonarPlugin;
  private configManager: ConfigManager;
  private logger: ComponentLogger;
  hoverPopover: HoverPopover | null = null; // HoverParent interface
  private lastActiveFile: TFile | null = null;
  private lastQuery: string = '';
  private searchAbortController: AbortController | null = null;
  private debouncedRefresh: () => void;
  private debouncedCursorRefresh: () => void;
  private debouncedScrollRefresh: () => void;
  private svelteComponent: any;
  private viewUnsubscribe: (() => void) | null = null;
  private sonarStateUnsubscribe: (() => void) | null = null;
  private relatedNotesStore = writable<RelatedNotesState>({
    ...EMPTY_STATE_BASE,
    status: 'no-active-note',
    queryMode: 'default',
  });

  constructor(
    leaf: WorkspaceLeaf,
    plugin: SonarPlugin,
    configManager: ConfigManager
  ) {
    super(leaf);
    this.plugin = plugin;
    this.configManager = configManager;
    this.logger = createComponentLogger(configManager, COMPONENT_ID);

    this.debouncedRefresh = debounce(
      this.refresh.bind(this),
      configManager.get('relatedNotesDebounceMs'),
      true
    );

    this.debouncedCursorRefresh = debounce(
      () => this.refresh(true),
      configManager.get('relatedNotesDebounceMs'),
      true
    );

    this.debouncedScrollRefresh = debounce(
      () => this.refresh(false),
      configManager.get('relatedNotesDebounceMs'),
      true
    );

    this.setupConfigListeners();
  }

  private setupConfigListeners(): void {
    this.configManager.subscribe('relatedNotesDebounceMs', (_, value) => {
      this.debouncedRefresh = debounce(this.refresh.bind(this), value, true);
      this.debouncedCursorRefresh = debounce(
        () => this.refresh(true),
        value,
        true
      );
      this.debouncedScrollRefresh = debounce(
        () => this.refresh(false),
        value,
        true
      );
    });

    this.configManager.subscribe('maxQueryTokens', () => {
      this.debouncedRefresh();
    });

    this.configManager.subscribe('searchResultsCount', () => {
      // Reset lastQuery to force re-search even with same query
      this.lastQuery = '';
      this.debouncedRefresh();
    });
  }

  private setupSonarStateSubscription(): void {
    let wasSearchReady = false;
    this.sonarStateUnsubscribe = isSearchReady.subscribe(ready => {
      if (ready && !wasSearchReady) {
        this.lastQuery = '';
        this.refreshWhenReady();
      }
      wasSearchReady = ready;
    });
  }

  private async refreshWhenReady(): Promise<void> {
    // Wait for searchManager to be available (it's created after embedder/stores are ready)
    const maxAttempts = 10;
    const delayMs = 500;
    for (let i = 0; i < maxAttempts; i++) {
      if (this.plugin.searchManager && this.plugin.embedder) {
        this.refresh(true);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    this.logger.warn('searchManager not available after waiting');
  }

  getViewType(): string {
    return RELATED_NOTES_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Related Notes';
  }

  getIcon(): string {
    return 'radar';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('related-notes-view-container');

    this.setupSonarStateSubscription();

    // Mount component once with reactive props
    this.mountComponent();

    this.plugin.registerEditorExtension(
      EditorView.updateListener.of(update => {
        if (update.selectionSet && !update.docChanged) {
          this.debouncedCursorRefresh();
        }
      })
    );

    this.plugin.registerMarkdownPostProcessor(
      (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        const info = ctx.getSectionInfo(el);
        if (info) {
          el.dataset.lineStart = String(info.lineStart);
          el.dataset.lineEnd = String(info.lineEnd);
        }
      }
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', async () => {
        await this.onActiveLeafChange();
      })
    );

    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        this.debouncedCursorRefresh();
      })
    );

    await this.onActiveLeafChange();
  }

  private mountComponent(): void {
    const container = this.containerEl.children[1];

    // Mount component once - it will subscribe to store changes
    this.svelteComponent = mount(RelatedNotesContent, {
      target: container,
      props: {
        app: this.app,
        configManager: this.configManager,
        store: this.relatedNotesStore,
        sonarState: sonarState as {
          subscribe: (fn: (value: SonarModelState) => void) => () => void;
        },
        isRerankerReady: isRerankerReady as {
          subscribe: (fn: (value: boolean) => void) => () => void;
        },
        onRefresh: () => {
          this.manualRefresh();
        },
        onRerankingToggle: (enabled: boolean) => {
          this.configManager.set('enableRelatedNotesReranking', enabled);
          this.lastQuery = '';
          this.refresh(true);
        },
        onSetQueryMode: (mode: QueryMode) => {
          const currentMode = get(this.relatedNotesStore).queryMode;
          this.updateStore({ queryMode: mode });
          if (mode === 'default' && currentMode !== 'default') {
            this.lastQuery = '';
            this.refresh(true);
          }
        },
        onQueryChange: (newQuery: string) => {
          this.searchWithCustomQuery(newQuery);
        },
        onHoverLink: (event: MouseEvent, linktext: string) =>
          this.handleHoverLink(event, linktext),
      },
    });
  }

  private handleHoverLink(event: MouseEvent, linktext: string): void {
    this.app.workspace.trigger('hover-link', {
      event,
      source: RELATED_NOTES_VIEW_TYPE,
      hoverParent: this,
      targetEl: event.target as HTMLElement,
      linktext,
      sourcePath: '',
    });
  }

  private updateStore(partialState: Partial<RelatedNotesState>): void {
    const currentState = get(this.relatedNotesStore);
    this.relatedNotesStore.set({ ...currentState, ...partialState });
  }

  private async onActiveLeafChange(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();

    if (activeFile && activeFile instanceof TFile) {
      const fileChanged = activeFile !== this.lastActiveFile;

      if (fileChanged) {
        this.clearViewListener();
        this.lastActiveFile = activeFile;
        this.lastQuery = '';
      }

      // For PDF/Audio: always re-register listener as the view container may be recreated
      if (activeFile.extension === 'pdf') {
        this.clearViewListener();
        this.setupPdfPageListener();
      } else if (isAudioExtension(activeFile.extension)) {
        this.clearViewListener();
        this.setupAudioPlaybackListener();
      } else if (fileChanged) {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          this.setupScrollListener(activeView);
        }
      }

      if (fileChanged) {
        await this.refresh(true);
      }
    } else if (!activeFile) {
      this.clearViewListener();
      this.lastActiveFile = null;
      this.lastQuery = '';
      this.updateStore({
        ...EMPTY_STATE_BASE,
        status: 'no-active-note',
      });
    }
  }

  private clearViewListener(): void {
    if (this.viewUnsubscribe) {
      this.viewUnsubscribe();
      this.viewUnsubscribe = null;
    }
  }

  private setupScrollListener(view: MarkdownView): void {
    const readingEl = view.containerEl.querySelector(
      '.markdown-preview-view'
    ) as HTMLElement;
    const editingEl = view.containerEl.querySelector(
      '.cm-scroller'
    ) as HTMLElement;

    const handler = () => {
      this.debouncedScrollRefresh();
    };

    if (readingEl) readingEl.addEventListener('scroll', handler);
    if (editingEl) editingEl.addEventListener('scroll', handler);
    this.viewUnsubscribe = () => {
      if (readingEl) readingEl.removeEventListener('scroll', handler);
      if (editingEl) editingEl.removeEventListener('scroll', handler);
    };
  }

  private getActiveAudioViewContainer(): HTMLElement | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !isAudioExtension(activeFile.extension)) return null;
    const leaf = this.app.workspace
      .getLeavesOfType('audio')
      .find(l => (l.view as any).file?.path === activeFile.path);
    return leaf?.view.containerEl ?? null;
  }

  private getActivePdfView(): PdfView | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'pdf') return null;
    const leaves = this.app.workspace.getLeavesOfType('pdf');
    for (const leaf of leaves) {
      const view = leaf.view as PdfView;
      if (view.file?.path === activeFile.path) {
        return view;
      }
    }
    return null;
  }

  private setupPdfPageListener(): void {
    const trySetup = (attempt: number = 0): void => {
      const pdfView = this.getActivePdfView();
      const pdfDocument = pdfView?.viewer?.child?.pdfViewer?.pdfDocument;
      const viewerContainer = pdfView?.containerEl.querySelector(
        '.pdf-viewer-container'
      ) as HTMLElement | null;

      // Wait for PDF view and document to be fully loaded
      if (!pdfView || !viewerContainer || !pdfDocument) {
        if (attempt < 20) {
          setTimeout(() => trySetup(attempt + 1), 500);
        } else {
          this.logger.warn('PDF viewer not fully loaded after retries');
        }
        return;
      }

      let lastPage = this.detectPdfCurrentPage();

      const handler = () => {
        const currentPage = this.detectPdfCurrentPage();
        if (currentPage !== null && currentPage !== lastPage) {
          lastPage = currentPage;
          this.lastQuery = '';
          this.debouncedScrollRefresh();
        }
      };
      viewerContainer.addEventListener('scroll', handler);
      this.viewUnsubscribe = () => {
        viewerContainer.removeEventListener('scroll', handler);
      };
      this.logger.log('PDF scroll listener registered');
    };

    trySetup();
  }

  private setupAudioPlaybackListener(): void {
    const trySetup = (attempt: number = 0): void => {
      const container = this.getActiveAudioViewContainer();
      if (!container) {
        if (attempt < 20) {
          setTimeout(() => trySetup(attempt + 1), 500);
        }
        return;
      }

      const audioEl = container.querySelector(
        'audio'
      ) as HTMLAudioElement | null;

      if (!audioEl) {
        if (attempt < 20) {
          setTimeout(() => trySetup(attempt + 1), 500);
        } else {
          this.logger.warn('Audio element not found after retries');
        }
        return;
      }

      let lastTime = Math.floor(audioEl.currentTime);
      const handler = () => {
        const currentTime = Math.floor(audioEl.currentTime);
        if (currentTime !== lastTime) {
          lastTime = currentTime;
          this.lastQuery = '';
          this.debouncedScrollRefresh();
        }
      };

      audioEl.addEventListener('timeupdate', handler);
      audioEl.addEventListener('seeked', handler);
      this.viewUnsubscribe = () => {
        audioEl.removeEventListener('timeupdate', handler);
        audioEl.removeEventListener('seeked', handler);
      };
      this.logger.log('Audio playback listener registered');
    };

    trySetup();
  }

  private detectAudioCurrentTime(): number | null {
    const container = this.getActiveAudioViewContainer();
    if (!container) return null;
    const audioEl = container.querySelector('audio') as HTMLAudioElement | null;
    if (!audioEl) return null;
    return audioEl.currentTime;
  }

  private async refresh(preferCursor: boolean = false): Promise<void> {
    // Skip auto-refresh when in editing mode (user controls the query)
    const currentState = get(this.relatedNotesStore);
    if (currentState.queryMode !== 'default') {
      return;
    }

    if (this.searchAbortController) {
      this.searchAbortController.abort();
      this.searchAbortController = null;
    }

    // Search not ready yet - UI state is handled by sonarState in Svelte
    if (!this.plugin.searchManager || !this.plugin.embedder) {
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !(activeFile instanceof TFile)) {
      this.updateStore({
        ...EMPTY_STATE_BASE,
        status: 'no-active-note',
      });
      return;
    }

    this.searchAbortController = new AbortController();
    const searchAbortSignal = this.searchAbortController.signal;

    this.updateStore({
      status: 'processing',
    });

    // Handle PDF and Audio files differently
    const ext = activeFile.extension;
    if (ext === 'pdf' || (ext && isAudioExtension(ext))) {
      await this.refreshFromMetadata(activeFile, searchAbortSignal);
      return;
    }

    let activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      const leaves = this.app.workspace.getLeavesOfType('markdown');
      activeView =
        (leaves.find(leaf => (leaf.view as MarkdownView).file === activeFile)
          ?.view as MarkdownView) || null;
    }

    const context = activeView
      ? getCurrentContext(activeView, preferCursor)
      : null;

    if (!context) {
      this.updateStore({
        ...EMPTY_STATE_BASE,
        status: 'unable-to-determine-position',
        activeFile: activeFile.path,
      });
      return;
    }

    const options: QueryOptions = {
      fileName: activeFile.basename,
      lineStart: context.lineStart,
      lineEnd: context.lineEnd,
      hasSelection: context.hasSelection,
      maxTokens: this.configManager.get('maxQueryTokens'),
      embedder: this.plugin.embedder,
    };

    try {
      const content = await this.app.vault.cachedRead(activeFile);
      const query = await processQuery(content, options);

      if (query === this.lastQuery) {
        this.updateStore({
          status: 'ready',
        });
        return;
      }

      this.lastQuery = query;

      if (query) {
        const tokenCount = await this.plugin.embedder.countTokens(query);
        const queryLabel = truncateQuery(query);

        const searchStart = performance.now();
        const searchResults = await this.plugin.searchManager.search(
          COMPONENT_ID,
          query,
          {
            topK: this.configManager.get('searchResultsCount'),
            excludeFilePath: activeFile.path,
          }
        );
        const searchTime = performance.now() - searchStart;

        // Skip if superseded (null from queue) or aborted (new refresh started)
        if (searchResults === null || searchAbortSignal.aborted) {
          return;
        }

        this.logger.log(
          `Searched ${queryLabel} in ${formatDuration(searchTime)}`
        );

        const enableReranking = this.configManager.get(
          'enableRelatedNotesReranking'
        );
        const topK = this.configManager.get('searchResultsCount');

        if (enableReranking && this.plugin.searchManager) {
          this.updateStore({
            query: query,
            results: searchResults,
            tokenCount: tokenCount,
            status: 'ready',
            activeFile: activeFile.path,
            isReranking: true,
          });

          const rerankStart = performance.now();
          const rerankedResults = await this.plugin.searchManager.rerank(
            COMPONENT_ID,
            query,
            searchResults,
            topK
          );
          const rerankTime = performance.now() - rerankStart;

          if (searchAbortSignal.aborted) {
            return;
          }

          if (rerankedResults) {
            this.logger.log(
              `Reranked ${queryLabel} in ${formatDuration(rerankTime)}`
            );
            this.updateStore({
              results: rerankedResults,
              isReranking: false,
            });
          } else {
            this.updateStore({
              isReranking: false,
            });
          }
        } else {
          this.updateStore({
            query: query,
            results: searchResults,
            tokenCount: tokenCount,
            status: 'ready',
            activeFile: activeFile.path,
          });
        }
      } else {
        this.updateStore({
          ...EMPTY_STATE_BASE,
          status: 'no-content',
          activeFile: activeFile.path,
        });
      }
    } catch (err) {
      if (searchAbortSignal.aborted) {
        return;
      }
      this.logger.error(`Error refreshing related notes: ${err}`);
      new Notice('Failed to retrieve related notes');
      this.updateStore({
        ...EMPTY_STATE_BASE,
        status: 'error',
        activeFile: activeFile.path,
      });
    }
  }

  private async refreshFromMetadata(
    file: TFile,
    abortSignal: AbortSignal
  ): Promise<void> {
    // Dependencies not ready yet - UI state is handled by sonarState in Svelte
    if (!this.plugin.metadataStore || !this.plugin.embedder) {
      return;
    }

    const chunks = await this.plugin.metadataStore.getChunksByFile(file.path);
    if (chunks.length === 0) {
      this.updateStore({
        ...EMPTY_STATE_BASE,
        status: 'no-content',
        activeFile: file.path,
      });
      return;
    }

    // Sort chunks by id to get proper order
    chunks.sort((a, b) => a.id.localeCompare(b.id));

    let query: string | null = null;

    try {
      if (file.extension === 'pdf') {
        const currentPage = this.detectPdfCurrentPage();
        if (currentPage !== null) {
          query = await this.getPdfPageText(currentPage);
        }
        if (!query) {
          // Fallback to first chunk from metadata
          query = chunks[0].content;
        }
      } else {
        // For Audio: use chunk closest to current playback position
        const currentTime = this.detectAudioCurrentTime();
        if (currentTime !== null) {
          const hasTimestamps = chunks.some(
            c => c.audioStartTime !== undefined
          );
          if (hasTimestamps) {
            let bestChunk = chunks[0];
            for (const chunk of chunks) {
              if (
                chunk.audioStartTime !== undefined &&
                chunk.audioStartTime <= currentTime
              ) {
                bestChunk = chunk;
              }
            }
            query = bestChunk.content;
          } else {
            query = chunks[0].content;
          }
        } else {
          query = chunks[0].content;
        }
      }

      // Truncate query if too long
      const maxTokens = this.configManager.get('maxQueryTokens');
      let tokenCount = await this.plugin.embedder.countTokens(query);
      while (tokenCount > maxTokens && query.length > 100) {
        query = query.slice(0, Math.floor(query.length * 0.8));
        tokenCount = await this.plugin.embedder.countTokens(query);
      }

      if (query === this.lastQuery) {
        this.updateStore({
          status: 'ready',
        });
        return;
      }

      this.lastQuery = query;

      const queryLabel = truncateQuery(query);

      const searchStart = performance.now();
      const searchResults = await this.plugin.searchManager!.search(
        COMPONENT_ID,
        query,
        {
          topK: this.configManager.get('searchResultsCount'),
          excludeFilePath: file.path,
        }
      );
      const searchTime = performance.now() - searchStart;

      if (searchResults === null || abortSignal.aborted) {
        return;
      }

      this.logger.log(
        `Searched ${queryLabel} in ${formatDuration(searchTime)}`
      );

      const enableReranking = this.configManager.get(
        'enableRelatedNotesReranking'
      );
      const topK = this.configManager.get('searchResultsCount');

      if (enableReranking && this.plugin.searchManager) {
        this.updateStore({
          query: query,
          results: searchResults,
          tokenCount: tokenCount,
          status: 'ready',
          activeFile: file.path,
          isReranking: true,
        });

        const rerankStart = performance.now();
        const rerankedResults = await this.plugin.searchManager.rerank(
          COMPONENT_ID,
          query,
          searchResults,
          topK
        );
        const rerankTime = performance.now() - rerankStart;

        if (abortSignal.aborted) {
          return;
        }

        if (rerankedResults) {
          this.logger.log(
            `Reranked ${queryLabel} in ${formatDuration(rerankTime)}`
          );
          this.updateStore({
            results: rerankedResults,
            isReranking: false,
          });
        } else {
          this.updateStore({
            isReranking: false,
          });
        }
      } else {
        this.updateStore({
          query: query,
          results: searchResults,
          tokenCount: tokenCount,
          status: 'ready',
          activeFile: file.path,
        });
      }
    } catch (err) {
      if (abortSignal.aborted) {
        return;
      }
      this.logger.error(`Error refreshing related notes from metadata: ${err}`);
      this.updateStore({
        ...EMPTY_STATE_BASE,
        status: 'error',
        activeFile: file.path,
      });
    }
  }

  private detectPdfCurrentPage(): number | null {
    const pdfView = this.getActivePdfView();
    if (!pdfView) return null;

    // Try internal API first (more reliable)
    const child = pdfView.viewer?.child;
    if (child?.pdfViewer?.page) {
      return child.pdfViewer.page;
    }

    // Fallback to DOM inspection
    const viewEl = pdfView.containerEl;
    const pageInput = viewEl.querySelector(
      '.pdf-toolbar input[type="number"]'
    ) as HTMLInputElement;
    if (pageInput && pageInput.value) {
      const page = parseInt(pageInput.value, 10);
      if (!isNaN(page) && page > 0) {
        return page;
      }
    }
    const pdfViewerEl = viewEl.querySelector('.pdf-viewer');
    if (pdfViewerEl) {
      const visiblePage = pdfViewerEl.querySelector(
        '.page[data-page-number]:not([hidden])'
      ) as HTMLElement;
      if (visiblePage?.dataset.pageNumber) {
        const page = parseInt(visiblePage.dataset.pageNumber, 10);
        if (!isNaN(page) && page > 0) {
          return page;
        }
      }
    }

    return null;
  }

  private async getPdfPageText(pageNumber: number): Promise<string | null> {
    const pdfView = this.getActivePdfView();
    if (!pdfView) return null;
    const pdfDocument = pdfView.viewer?.child?.pdfViewer?.pdfDocument;
    if (!pdfDocument) return null;

    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const textParts: string[] = [];
    for (const item of textContent.items) {
      const textItem = item as TextItem;
      if (textItem.str) {
        textParts.push(textItem.str);
        if (textItem.hasEOL) {
          textParts.push('\n');
        }
      }
    }
    return normalizeText(textParts.join(''));
  }

  private manualRefresh(): void {
    const currentState = get(this.relatedNotesStore);
    if (currentState.queryMode === 'editing') {
      // When editing, re-search with the current edited query
      this.searchWithCustomQuery(currentState.query);
    } else {
      this.lastQuery = '';
      this.refresh(true);
    }
  }

  private async searchWithCustomQuery(query: string): Promise<void> {
    if (!this.plugin.searchManager || !this.plugin.embedder) {
      return;
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'no-content',
      });
      return;
    }

    if (this.searchAbortController) {
      this.searchAbortController.abort();
    }
    this.searchAbortController = new AbortController();
    const searchAbortSignal = this.searchAbortController.signal;

    this.updateStore({
      query: trimmedQuery,
      status: 'processing',
    });

    try {
      const tokenCount = await this.plugin.embedder.countTokens(trimmedQuery);
      const queryLabel = truncateQuery(trimmedQuery);
      const activeFile = this.app.workspace.getActiveFile();

      const searchStart = performance.now();
      const searchResults = await this.plugin.searchManager.search(
        COMPONENT_ID,
        trimmedQuery,
        {
          topK: this.configManager.get('searchResultsCount'),
          excludeFilePath: activeFile?.path,
        }
      );
      const searchTime = performance.now() - searchStart;

      if (searchResults === null || searchAbortSignal.aborted) {
        return;
      }

      this.logger.log(
        `Searched ${queryLabel} in ${formatDuration(searchTime)}`
      );

      const enableReranking = this.configManager.get(
        'enableRelatedNotesReranking'
      );
      const topK = this.configManager.get('searchResultsCount');

      if (enableReranking && this.plugin.searchManager) {
        this.updateStore({
          query: trimmedQuery,
          results: searchResults,
          tokenCount: tokenCount,
          status: 'ready',
          isReranking: true,
        });

        const rerankStart = performance.now();
        const rerankedResults = await this.plugin.searchManager.rerank(
          COMPONENT_ID,
          trimmedQuery,
          searchResults,
          topK
        );
        const rerankTime = performance.now() - rerankStart;

        if (searchAbortSignal.aborted) {
          return;
        }

        if (rerankedResults) {
          this.logger.log(
            `Reranked ${queryLabel} in ${formatDuration(rerankTime)}`
          );
          this.updateStore({
            results: rerankedResults,
            isReranking: false,
          });
        } else {
          this.updateStore({
            isReranking: false,
          });
        }
      } else {
        this.updateStore({
          query: trimmedQuery,
          results: searchResults,
          tokenCount: tokenCount,
          status: 'ready',
        });
      }
    } catch (err) {
      if (searchAbortSignal.aborted) {
        return;
      }
      this.logger.error(`Error searching with custom query: ${err}`);
      new Notice('Failed to search');
      this.updateStore({
        status: 'error',
      });
    }
  }

  async onClose(): Promise<void> {
    // Cancel pending requests to prevent sending to server
    if (this.plugin.searchManager)
      this.plugin.searchManager.cancelPendingRequests(COMPONENT_ID);

    if (this.sonarStateUnsubscribe) {
      this.sonarStateUnsubscribe();
      this.sonarStateUnsubscribe = null;
    }
    this.clearViewListener();
    if (this.svelteComponent) {
      unmount(this.svelteComponent);
    }
  }
}
