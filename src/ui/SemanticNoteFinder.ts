import { App, Modal, Notice, debounce } from 'obsidian';
import { mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import { SearchManager, type SearchResult } from '../SearchManager';
import { ConfigManager } from '../ConfigManager';
import { createComponentLogger, type ComponentLogger } from '../WithLogging';
import { truncateQuery, formatDuration } from '../utils';
import SemanticNoteFinderComponent from './SemanticNoteFinderComponent.svelte';

interface SemanticSearchState {
  query: string;
  results: SearchResult[];
  isSearching: boolean;
  isReranking: boolean;
}

const SEARCH_DEBOUNCE_MS = 750;
const MAX_INITIAL_K = 100;

const COMPONENT_ID = 'SemanticNoteFinder';

export class SemanticNoteFinder extends Modal {
  private searchManager: SearchManager;
  private configManager: ConfigManager;
  private logger: ComponentLogger;
  private svelteComponent:
    | ReturnType<typeof SemanticNoteFinderComponent>
    | undefined;
  private debouncedSearch: (query: string) => void;
  private searchStore = writable<SemanticSearchState>({
    query: '',
    results: [],
    isSearching: false,
    isReranking: false,
  });
  private searchAbortController: AbortController | null = null;
  private cache = {
    lastQuery: '',
    default: new Map<string, SearchResult[]>(),
    reranked: new Map<string, SearchResult[]>(),
  };

  constructor(
    app: App,
    searchManager: SearchManager,
    configManager: ConfigManager
  ) {
    super(app);
    this.searchManager = searchManager;
    this.configManager = configManager;
    this.logger = createComponentLogger(configManager, COMPONENT_ID);

    this.debouncedSearch = debounce(
      this.handleSearch.bind(this),
      SEARCH_DEBOUNCE_MS,
      true
    );
  }

  private updateStore(updates: Partial<SemanticSearchState>): void {
    this.searchStore.update(state => ({
      ...state,
      ...updates,
    }));
  }

  private async handleSearch(query: string): Promise<void> {
    if (this.searchAbortController) {
      this.searchAbortController.abort();
      this.searchAbortController = null;
    }

    const trimmedQuery = query.trim();

    this.cache.lastQuery = trimmedQuery;

    if (!trimmedQuery) {
      this.updateStore({
        query: '',
        results: [],
        isSearching: false,
        isReranking: false,
      });
      return;
    }

    const enableReranking = this.configManager.get('enableSearchReranking');
    const cacheMap = enableReranking ? this.cache.reranked : this.cache.default;
    const cachedResults = cacheMap.get(trimmedQuery);
    if (cachedResults) {
      const topK = this.configManager.get('searchResultsCount');
      this.updateStore({
        query,
        results: cachedResults.slice(0, topK),
        isSearching: false,
        isReranking: false,
      });
      return;
    }

    this.searchAbortController = new AbortController();
    const searchAbortSignal = this.searchAbortController.signal;

    this.updateStore({
      query,
      isSearching: true,
      isReranking: false,
    });

    const topK = this.configManager.get('searchResultsCount');
    const retrievalMultiplier = this.configManager.get('retrievalMultiplier');
    const initialK = enableReranking
      ? Math.min(topK * retrievalMultiplier, MAX_INITIAL_K)
      : topK;

    const queryLabel = truncateQuery(trimmedQuery);

    try {
      const searchStart = performance.now();
      const initialResults = await this.searchManager.search(
        COMPONENT_ID,
        trimmedQuery,
        {
          topK: initialK,
          titleWeight: 0.25,
          contentWeight: 0.75,
        }
      );
      const searchTime = performance.now() - searchStart;

      this.logger.log(
        `Searched ${queryLabel} in ${formatDuration(searchTime)}`
      );

      // Skip if superseded (null from queue) or aborted (new search started)
      if (initialResults === null || searchAbortSignal.aborted) {
        return;
      }

      if (enableReranking && initialResults.length > 0) {
        const showIntermediate = this.configManager.get(
          'showIntermediateResults'
        );
        this.updateStore({
          results: showIntermediate ? initialResults.slice(0, topK) : [],
          isSearching: false,
        });
        // Debounce reranking since it's expensive and time-consuming
        setTimeout(() => {
          if (searchAbortSignal.aborted) return;
          this.updateStore({ isReranking: true });
          this.executeReranking(
            query,
            trimmedQuery,
            initialResults,
            topK,
            searchAbortSignal,
            queryLabel
          );
        }, SEARCH_DEBOUNCE_MS);
      } else {
        // No reranking: show initial results immediately
        this.cache.default.set(trimmedQuery, initialResults);
        this.updateStore({
          results: initialResults.slice(0, topK),
          isSearching: false,
        });
      }
    } catch (err) {
      this.logger.error(`Search failed: ${err}`);
      new Notice('Search failed. Please check your settings.');
      if (searchAbortSignal.aborted) return;
      this.updateStore({
        results: [],
        isSearching: false,
        isReranking: false,
      });
    }
  }

  private async executeReranking(
    query: string,
    cacheKey: string,
    initialResults: SearchResult[],
    topK: number,
    searchAbortSignal: AbortSignal,
    queryLabel: string
  ): Promise<void> {
    try {
      const rerankStart = performance.now();
      const rerankedResults = await this.searchManager.rerank(
        COMPONENT_ID,
        query,
        initialResults,
        topK
      );
      const rerankTime = performance.now() - rerankStart;

      this.logger.log(
        `Reranked ${queryLabel} in ${formatDuration(rerankTime)}`
      );

      const finalResults = rerankedResults ?? initialResults.slice(0, topK);
      this.cache.reranked.set(cacheKey, finalResults);

      if (searchAbortSignal.aborted) return;
      this.updateStore({
        results: finalResults,
        isReranking: false,
      });
    } catch (err) {
      this.logger.error(`Reranking failed: ${err}`);
      // On failure, show initial results
      const fallbackResults = initialResults.slice(0, topK);
      this.cache.reranked.set(cacheKey, fallbackResults);
      if (searchAbortSignal.aborted) return;
      this.updateStore({
        results: fallbackResults,
        isReranking: false,
      });
    }
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    titleEl.empty();

    this.modalEl.addClass('semantic-search-modal');
    this.modalEl.style.width = '800px';
    this.modalEl.style.height = '600px';

    // Restore last query from cache if available
    if (this.cache.lastQuery) {
      const enableReranking = this.configManager.get('enableSearchReranking');
      const cacheMap = enableReranking
        ? this.cache.reranked
        : this.cache.default;
      const cachedResults = cacheMap.get(this.cache.lastQuery);
      if (cachedResults) {
        const topK = this.configManager.get('searchResultsCount');
        this.updateStore({
          query: this.cache.lastQuery,
          results: cachedResults.slice(0, topK),
          isSearching: false,
          isReranking: false,
        });
      } else {
        // Cache invalidated: trigger auto-search
        this.debouncedSearch(this.cache.lastQuery);
      }
    }

    this.svelteComponent = mount(SemanticNoteFinderComponent, {
      target: contentEl,
      props: {
        app: this.app,
        store: this.searchStore,
        configManager: this.configManager,
        placeholder: 'Enter your search query...',
        titleEl: titleEl,
        onQueryChange: (query: string) => {
          this.updateStore({ query });
          this.debouncedSearch(query);
        },
        onSearchImmediate: (query: string) => {
          this.handleSearch(query);
        },
        onRerankingToggle: () => {
          const currentQuery = this.cache.lastQuery;
          if (currentQuery) {
            this.handleSearch(currentQuery);
          }
        },
        onClose: () => {
          this.close();
        },
      },
    });
  }

  onClose(): void {
    // Cancel queued requests (in-flight search continues to populate cache)
    this.searchManager.cancelPendingRequests(COMPONENT_ID);

    const { contentEl } = this;
    if (this.svelteComponent) {
      unmount(this.svelteComponent);
    }
    contentEl.empty();

    // Reset store on close (cachedState is preserved for next open)
    this.updateStore({
      query: '',
      results: [],
      isSearching: false,
      isReranking: false,
    });
  }

  invalidateCache(): void {
    this.cache.default.clear();
    this.cache.reranked.clear();
  }
}
