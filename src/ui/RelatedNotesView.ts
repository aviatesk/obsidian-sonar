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
import { EditorView } from '@codemirror/view';
import { mount, unmount } from 'svelte';
import { writable, get } from 'svelte/store';
import { sonarState, type SonarModelState } from '../SonarModelState';
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

interface RelatedNotesState {
  query: string;
  results: SearchResult[];
  tokenCount: number;
  status: RelatedNotesStatus;
  activeFile: string | null;
}

const EMPTY_STATE_BASE: Omit<RelatedNotesState, 'status'> = {
  query: '',
  results: [],
  tokenCount: 0,
  activeFile: null,
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
  private scrollUnsubscribe: (() => void) | null = null;
  private sonarStateUnsubscribe: (() => void) | null = null;
  private relatedNotesStore = writable<RelatedNotesState>({
    ...EMPTY_STATE_BASE,
    status: 'initializing',
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
  }

  private setupSonarStateSubscription(): void {
    let previousState: SonarModelState | null = null;

    this.sonarStateUnsubscribe = sonarState.subscribe(state => {
      const currentStatus = get(this.relatedNotesStore).status;

      if (state.embedder === 'failed') {
        if (currentStatus !== 'initialization-failed') {
          this.updateStore({
            ...EMPTY_STATE_BASE,
            status: 'initialization-failed',
          });
        }
      } else if (state.embedder === 'ready') {
        // Trigger refresh when embedder becomes ready
        if (previousState?.embedder !== 'ready') {
          this.lastQuery = '';
          this.refresh(true);
        }
      } else if (state.embedder === 'initializing') {
        if (
          currentStatus !== 'initializing' &&
          currentStatus !== 'processing'
        ) {
          this.updateStore({
            ...EMPTY_STATE_BASE,
            status: 'initializing',
          });
        }
      }

      previousState = state;
    });
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
        onRefresh: () => {
          this.manualRefresh();
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

    if (this.scrollUnsubscribe) {
      this.scrollUnsubscribe();
      this.scrollUnsubscribe = null;
    }

    if (
      activeFile &&
      activeFile instanceof TFile &&
      activeFile !== this.lastActiveFile
    ) {
      this.lastActiveFile = activeFile;
      this.lastQuery = '';

      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        this.setupScrollListener(activeView);
      }

      await this.refresh(true);
    } else if (!activeFile) {
      this.lastActiveFile = null;
      this.lastQuery = '';
      this.updateStore({
        ...EMPTY_STATE_BASE,
        status: 'no-active-note',
      });
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
    this.scrollUnsubscribe = () => {
      if (readingEl) readingEl.removeEventListener('scroll', handler);
      if (editingEl) editingEl.removeEventListener('scroll', handler);
    };
  }

  private async refresh(preferCursor: boolean = false): Promise<void> {
    if (this.searchAbortController) {
      this.searchAbortController.abort();
      this.searchAbortController = null;
    }

    if (!this.plugin.searchManager || !this.plugin.embedder) {
      this.updateStore({
        ...EMPTY_STATE_BASE,
        status: 'initializing',
      });
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

        this.updateStore({
          query: query,
          results: searchResults,
          tokenCount: tokenCount,
          status: 'ready',
          activeFile: activeFile.path,
        });
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
    if (!this.plugin.metadataStore || !this.plugin.embedder) {
      this.updateStore({
        ...EMPTY_STATE_BASE,
        status: 'initializing',
      });
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

    let query: string;

    try {
      if (file.extension === 'pdf') {
        // For PDF: try to detect current page from viewer
        const currentPage = this.detectPdfCurrentPage();
        if (currentPage !== null) {
          // Find chunks for current page
          const pageChunks = chunks.filter(c => c.pageNumber === currentPage);
          query =
            pageChunks.length > 0
              ? pageChunks.map(c => c.content).join('\n')
              : chunks[0].content;
        } else {
          // Fallback to first chunk
          query = chunks[0].content;
        }
      } else {
        // For Audio: use first chunk (beginning of transcription)
        // TODO Use chunk corresponding to current timestamp
        query = chunks[0].content;
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

      this.updateStore({
        query: query,
        results: searchResults,
        tokenCount: tokenCount,
        status: 'ready',
        activeFile: file.path,
      });
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
    // Try to detect current page from Obsidian's PDF viewer
    // Look for the page indicator in the PDF viewer toolbar
    const activeLeaf = this.app.workspace.activeLeaf;
    if (!activeLeaf) return null;

    const viewEl = activeLeaf.view.containerEl;

    // Obsidian's PDF viewer has a page input showing current page
    const pageInput = viewEl.querySelector(
      '.pdf-toolbar input[type="number"]'
    ) as HTMLInputElement;
    if (pageInput && pageInput.value) {
      const page = parseInt(pageInput.value, 10);
      if (!isNaN(page) && page > 0) {
        return page;
      }
    }

    // Alternative: look for visible page in the viewer
    const pdfViewer = viewEl.querySelector('.pdf-viewer');
    if (pdfViewer) {
      // pdf.js typically marks the current page with data attributes
      const visiblePage = pdfViewer.querySelector(
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

  private manualRefresh(): void {
    this.lastQuery = '';
    this.refresh(true);
  }

  async onClose(): Promise<void> {
    // Cancel pending requests to prevent sending to server
    if (this.plugin.searchManager)
      this.plugin.searchManager.cancelPendingRequests(COMPONENT_ID);

    if (this.sonarStateUnsubscribe) {
      this.sonarStateUnsubscribe();
      this.sonarStateUnsubscribe = null;
    }
    if (this.scrollUnsubscribe) {
      this.scrollUnsubscribe();
      this.scrollUnsubscribe = null;
    }
    if (this.svelteComponent) {
      unmount(this.svelteComponent);
    }
  }
}
