<script lang="ts">
  import { App, Notice } from 'obsidian';
  import type { ConfigManager } from '../ConfigManager';
  import { Tokenizer } from '../Tokenizer';
  import SearchResults from './SearchResults.svelte';
  import type { Logger } from '../Logger';
  import { BrainCircuit, RefreshCw, Eye, EyeOff, Quote, createElement } from 'lucide';
  import { onMount } from 'svelte';

  interface Props {
    app: App;
    configManager: ConfigManager;
    store: any; // Svelte store
    logger: Logger;
    onRefresh: () => void;
    onToggleWithExtraction: (value: boolean) => void;
  }

  let {
    app,
    configManager,
    store,
    logger,
    onRefresh,
    onToggleWithExtraction,
  }: Props = $props();

  const storeState = $derived($store);
  const query = $derived(storeState.query);
  const results = $derived(storeState.results);
  const tokenCount = $derived(storeState.tokenCount);
  const status = $derived(storeState.status);
  const hasQuery = $derived(query && query.trim().length > 0);
  let withExtraction = $state(configManager.get('withExtraction'));
  let showQuery = $state(configManager.get('showRelatedNotesQuery'));
  let showExcerpts = $state(configManager.get('showRelatedNotesExcerpts'));
  let brainIcon: HTMLElement;
  let refreshIcon: HTMLElement;
  let eyeIcon: HTMLElement;
  let excerptIcon: HTMLElement;

  // Dynamic icons that change with state
  $effect(() => {
    if (eyeIcon) {
      const icon = createElement(showQuery ? Eye : EyeOff);
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      // eslint-disable-next-line svelte/no-dom-manipulating
      eyeIcon.replaceChildren(icon);
    }
  });

  $effect(() => {
    if (excerptIcon) {
      const icon = createElement(Quote);
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      // eslint-disable-next-line svelte/no-dom-manipulating
      excerptIcon.replaceChildren(icon);
    }
  });

  // Static icons only need onMount
  onMount(() => {
    if (brainIcon) {
      const icon = createElement(BrainCircuit);
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      // eslint-disable-next-line svelte/no-dom-manipulating
      brainIcon.appendChild(icon);
    }

    if (refreshIcon) {
      const icon = createElement(RefreshCw);
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      // eslint-disable-next-line svelte/no-dom-manipulating
      refreshIcon.appendChild(icon);
    }
  });

  function handleWithExtractionToggle() {
    withExtraction = !withExtraction;
    onToggleWithExtraction(withExtraction);
  }

  function handleRefresh() {
    if (status === 'Processing...') {
      new Notice('Processing in progress. Please wait.');
      return;
    }
    onRefresh();
  }

  function handleToggleQuery() {
    showQuery = !showQuery;
    configManager.set('showRelatedNotesQuery', showQuery);
  }

  function handleToggleExcerpts() {
    showExcerpts = !showExcerpts;
    configManager.set('showRelatedNotesExcerpts', showExcerpts);
  }
</script>

<div class="related-notes-view">
  <div class="related-notes-header">
    <div class="status-container">
      <div class="status-indicator">
        {#if status === 'Processing...'}
          <span class="spinner"></span>
        {/if}
        <span>{status}</span>
      </div>

      <div class="controls-container">
        <button
          class="icon-button toggle-query-btn"
          class:active={showQuery}
          aria-label="Toggle search query visibility"
          onclick={handleToggleQuery}
        >
          <span bind:this={eyeIcon}></span>
        </button>

        <button
          class="icon-button toggle-excerpts-btn"
          class:active={showExcerpts}
          aria-label="Toggle result excerpts visibility"
          onclick={handleToggleExcerpts}
        >
          <span bind:this={excerptIcon}></span>
        </button>

        <button
          class="icon-button with-llm-extraction-btn"
          class:active={withExtraction}
          aria-label="Uses LLM to extract relevant context"
          onclick={handleWithExtractionToggle}
        >
          <span bind:this={brainIcon}></span>
        </button>

        <button
          class="icon-button refresh-button"
          aria-label="Refresh search results"
          onclick={handleRefresh}
        >
          <span bind:this={refreshIcon}></span>
        </button>
      </div>
    </div>
  </div>

  <div class="related-notes-content">
    {#if hasQuery && showQuery}
      <div class="current-query">
        <div class="query-header">
          <h4>Search Query</h4>
          <span class="query-length">{Tokenizer.formatTokenCount(tokenCount)}</span>
        </div>
        <div class="query-text">
          {query}
        </div>
      </div>
    {/if}

    {#if hasQuery}
      <div class="related-notes-results">
        <SearchResults
          {app}
          {results}
          {logger}
          noResultsMessage="No related notes found"
          maxHeight="200px"
          showExcerpts={showExcerpts}
        />
      </div>
    {:else}
      <div class="empty-state">
        <span>{status}</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .related-notes-view {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .related-notes-header {
    padding: 12px 16px;
    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .status-container {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--background-modifier-border);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .controls-container {
    display: flex;
    gap: 6px;
  }

  .icon-button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 6px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .icon-button:hover {
    background: var(--background-primary);
    border-color: var(--background-modifier-border);
    color: var(--text-normal);
  }

  .icon-button.active {
    background: var(--interactive-accent);
    border-color: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .icon-button.active:hover {
    background: var(--interactive-accent-hover);
    border-color: var(--interactive-accent-hover);
  }

  .related-notes-content {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .current-query {
    margin: 12px;
    padding: 12px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
  }

  .query-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .query-header h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .query-length {
    font-size: 10px;
    padding: 2px 6px;
    background: var(--background-modifier-border);
    color: var(--text-muted);
    border-radius: 4px;
  }

  .query-text {
    font-size: 12px;
    color: var(--text-normal);
    word-break: break-word;
    max-height: 80px;
    overflow-y: auto;
    line-height: 1.5;
    padding-right: 8px;
  }

  .query-text::-webkit-scrollbar {
    width: 6px;
  }

  .query-text::-webkit-scrollbar-track {
    background: transparent;
  }

  .query-text::-webkit-scrollbar-thumb {
    background: var(--background-modifier-border);
    border-radius: 3px;
  }

  .query-text::-webkit-scrollbar-thumb:hover {
    background: var(--text-muted);
  }

  .related-notes-results {
    flex: 1;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 24px;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
