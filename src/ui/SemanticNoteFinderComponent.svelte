<script lang="ts">
  import { App } from 'obsidian';
  import SearchResults from './SearchResults.svelte';

  import type { ConfigManager } from '../ConfigManager';

  interface Props {
    app: App;
    store: any; // Svelte store
    configManager: ConfigManager;
    placeholder?: string;
    titleEl: HTMLElement;
    onQueryChange: (query: string) => void;
    onSearchImmediate: (query: string) => void;
    onClose?: () => void;
  }

  let {
    app,
    store,
    configManager,
    placeholder = 'Enter your search query...',
    titleEl,
    onQueryChange,
    onSearchImmediate,
    onClose,
  }: Props = $props();

  // Get reactive state from store
  const storeState = $derived($store);
  const query = $derived(storeState.query);
  const results = $derived(storeState.results);
  const isSearching = $derived(storeState.isSearching);
  const hasSearched = $derived(storeState.hasSearched);

  let inputEl: HTMLInputElement;
  let searchInputContainer: HTMLDivElement;

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
  {#if isSearching}
    <div class="search-status">
      <span class="spinner"></span>
      Searching...
    </div>
  {/if}
</div>

<div class="search-results-container">
  {#if hasSearched}
    <SearchResults
      {app}
      {results}
      {configManager}
      noResultsMessage={isSearching ? 'Searching...' : 'No results found for your query'}
      onFileClick={(file) => {
        app.workspace.getLeaf(false).openFile(file);
        onClose?.();
      }}
    />
  {/if}
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
    padding: 8px 12px;
    color: var(--text-muted);
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
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
