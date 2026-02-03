<script lang="ts">
  import { App } from 'obsidian';
  import { onMount, untrack } from 'svelte';
  import { Sparkles, Zap, createElement } from 'lucide';
  import SearchResults from './SearchResults.svelte';

  import type { ConfigManager } from '../ConfigManager';

  interface Props {
    app: App;
    store: any; // Svelte store
    configManager: ConfigManager;
    placeholder?: string;
    titleEl: HTMLElement;
    isRerankerReady: boolean;
    onQueryChange: (query: string) => void;
    onSearchImmediate: (query: string) => void;
    onRerankingToggle: (enabled: boolean) => void;
    onHoverLink?: (event: MouseEvent, linktext: string) => void;
    onClose?: () => void;
  }

  let {
    app,
    store,
    configManager,
    placeholder = 'Enter your search query...',
    titleEl,
    isRerankerReady,
    onQueryChange,
    onSearchImmediate,
    onRerankingToggle,
    onHoverLink,
    onClose,
  }: Props = $props();

  // Get reactive state from store
  const storeState = $derived($store);
  const query = $derived(storeState.query);
  const results = $derived(storeState.results);
  const isSearching = $derived(storeState.isSearching);
  const isReranking = $derived(storeState.isReranking);

  let enableReranking = $state(untrack(() => configManager.get('enableSearchReranking')));
  let showIntermediateResults = $state(
    untrack(() => configManager.get('showIntermediateResults'))
  );
  let inputEl: HTMLInputElement;
  let searchInputContainer: HTMLDivElement;
  let rerankIcon = $state<HTMLElement | undefined>(undefined);
  let intermediateIcon = $state<HTMLElement | undefined>(undefined);

  onMount(() => {
    if (rerankIcon) {
      const icon = createElement(Sparkles);
      icon.setAttribute('width', '14');
      icon.setAttribute('height', '14');
      // eslint-disable-next-line svelte/no-dom-manipulating
      rerankIcon.appendChild(icon);
    }
    if (intermediateIcon) {
      const icon = createElement(Zap);
      icon.setAttribute('width', '14');
      icon.setAttribute('height', '14');
      // eslint-disable-next-line svelte/no-dom-manipulating
      intermediateIcon.appendChild(icon);
    }
  });

  function handleToggleReranking() {
    enableReranking = !enableReranking;
    configManager.set('enableSearchReranking', enableReranking);
    onRerankingToggle(enableReranking);
  }

  function handleToggleIntermediate() {
    showIntermediateResults = !showIntermediateResults;
    configManager.set('showIntermediateResults', showIntermediateResults);
  }

  function handleInputChange(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    onQueryChange(value);
  }

  // Mount search input to titleEl
  $effect(() => {
    if (searchInputContainer && titleEl) {
      titleEl.appendChild(searchInputContainer);
    }
    if (inputEl) {
      inputEl.focus();
    }
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      const value = (event.target as HTMLInputElement).value;
      onSearchImmediate(value);
    }
  }
</script>

<div class="search-input-container" bind:this={searchInputContainer}>
  <input
    type="text"
    class="search-input"
    bind:this={inputEl}
    value={query}
    oninput={handleInputChange}
    onkeydown={handleKeydown}
    {placeholder}
  />
  {#if isSearching || isReranking}
    <div class="search-status" class:reranking={isReranking}>
      <span class="spinner"></span>
      {isReranking ? 'Reranking...' : 'Searching...'}
    </div>
  {/if}
  <button
    class="rerank-toggle-btn"
    class:active={enableReranking && isRerankerReady}
    class:disabled={!isRerankerReady}
    aria-label={isRerankerReady ? 'Toggle reranking' : 'Reranker not available'}
    disabled={!isRerankerReady}
    onclick={handleToggleReranking}
  >
    <span bind:this={rerankIcon}></span>
  </button>
  {#if enableReranking && isRerankerReady}
    <button
      class="intermediate-toggle-btn"
      class:active={showIntermediateResults}
      aria-label="Toggle intermediate results"
      onclick={handleToggleIntermediate}
    >
      <span bind:this={intermediateIcon}></span>
    </button>
  {/if}
</div>

<div class="search-results-container">
  <SearchResults
    {app}
    {results}
    {configManager}
    onFileClick={(file) => {
      app.workspace.getLeaf(false).openFile(file);
      onClose?.();
    }}
    {onHoverLink}
  />
</div>

<style>
  .search-input-container {
    display: flex;
    align-items: center;
    margin: 0 32px;
  }

  .search-input {
    flex: 1;
    padding: 0 32px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: 14px;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
  }

  .search-status {
    padding: 0px 12px;
    color: var(--text-muted);
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .search-status.reranking {
    color: var(--text-accent);
  }

  .rerank-toggle-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 6px;
    margin-left: 1em;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .rerank-toggle-btn:hover {
    background: var(--background-primary);
    border-color: var(--background-modifier-border);
    color: var(--text-normal);
  }

  .rerank-toggle-btn.active {
    background: var(--interactive-accent);
    border-color: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .rerank-toggle-btn.active:hover {
    background: var(--interactive-accent-hover);
    border-color: var(--interactive-accent-hover);
  }

  .rerank-toggle-btn.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .rerank-toggle-btn.disabled:hover {
    background: transparent;
    border-color: transparent;
    color: var(--text-muted);
  }

  .intermediate-toggle-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 6px;
    margin-left: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .intermediate-toggle-btn:hover {
    background: var(--background-primary);
    border-color: var(--background-modifier-border);
    color: var(--text-normal);
  }

  .intermediate-toggle-btn.active {
    background: var(--interactive-accent);
    border-color: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .intermediate-toggle-btn.active:hover {
    background: var(--interactive-accent-hover);
    border-color: var(--interactive-accent-hover);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--text-muted);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .search-results-container {
    padding: 0 16px;
  }
</style>
