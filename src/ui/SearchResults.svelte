<script lang="ts">
  import { App, TFile } from 'obsidian';
  import type { SearchResult } from '../EmbeddingSearch';
  import { MarkdownRenderingManager } from './MarkdownRenderingManager';
  import { onDestroy } from 'svelte';

  interface Props {
    app: App;
    results: SearchResult[];
    onFileClick?: (file: TFile) => void;
    noResultsMessage?: string;
    maxHeight?: string;
    maxLength?: number,
  }

  let {
    app,
    results = [],
    onFileClick,
    noResultsMessage = 'No results found',
    maxHeight = '100px',
    maxLength = undefined,
  }: Props = $props();

  const markdownManager = new MarkdownRenderingManager(app, { maxLength });

  onDestroy(() => {
    markdownManager.cleanup();
  });

  function setExcerptElement(node: HTMLElement, index: number) {
    const result = results[index];
    if (result) {
      requestAnimationFrame(() => {
        if (node.parentElement) {
          node.empty();
          markdownManager.render(result.content, node, result.metadata.filePath);
        }
      });
    }
    return {
      destroy() {
        markdownManager.cleanupElement(node);
      },
    };
  }

  async function handleTitleClick(result: SearchResult) {
    const file = app.vault.getAbstractFileByPath(result.metadata.filePath);
    if (file instanceof TFile) {
      if (onFileClick) {
        onFileClick(file);
      } else {
        await app.workspace.getLeaf(false).openFile(file);
      }
    }
  }

  function getDisplayTitle(result: SearchResult): string {
    return (
      result.metadata.title ||
      result.metadata.filePath.split('/').pop()?.replace('.md', '') ||
      'Untitled'
    );
  }

  function getScorePercent(score: number): number {
    return Math.round(score * 100);
  }

</script>

{#if results.length === 0}
  <p class="no-results">{noResultsMessage}</p>
{:else}
  <div class="results-list">
    {#each results as result, index (`${result.metadata.filePath}-${index}`)}
      <div class="result-item">
        <div
          class="score-bar"
          style:--score-width="{getScorePercent(result.score)}%"
          data-score="{getScorePercent(result.score)}%"
        ></div>

        <div class="result-content">
          <div class="title-container">
            <button
              class="result-title"
              onclick={() => handleTitleClick(result)}
              type="button"
            >
              {getDisplayTitle(result)}
            </button>
            <span class="result-score" title="Similarity score">{result.score.toFixed(3)}</span>
          </div>

          <div class="result-path">{result.metadata.filePath}</div>

          {#if result.metadata.headings && result.metadata.headings.length > 0}
            <div class="result-headings">
              {result.metadata.headings.join(' › ')}
            </div>
          {/if}

          <div
            class="result-excerpt"
            style:max-height={maxHeight}
            use:setExcerptElement={index}
          ></div>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .no-results {
    color: var(--text-muted);
    text-align: center;
    padding: 20px;
  }

  .results-list {
    padding: 10px;
  }

  .result-item {
    position: relative;
    margin-bottom: 16px;
    border-radius: 8px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    transition: all 0.2s ease;
    overflow: hidden;
  }

  .result-item:hover {
    background: var(--background-secondary-alt);
    border-color: var(--interactive-accent);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .result-content {
    padding: 16px;
  }

  .score-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--background-modifier-border);
    border-radius: 8px 8px 0 0;
    overflow: hidden;
  }

  .score-bar::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    width: var(--score-width);
    background: linear-gradient(90deg, var(--interactive-accent), var(--interactive-accent-hover));
    transition: width 0.3s ease;
  }

  .title-container {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    gap: 8px;
    min-width: 0; /* Allow flex items to shrink below content width */
  }

  .result-title {
    margin: 0;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-normal);
    cursor: pointer;
    text-decoration: none;
    font-size: 14px;
    font-weight: 600;
    text-align: left;
    flex: 1;
    min-width: 0; /* Allow text truncation */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-title:hover {
    text-decoration: underline;
  }

  .result-score {
    font-size: 11px;
    padding: 2px 6px;
    color: var(--text-muted);
    border-radius: 4px;
    flex-shrink: 0; /* Prevent score badge from shrinking */
    border: 1px solid var(--interactive-accent);
    font-weight: 600;
  }

  .result-path {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 6px;
    opacity: 0.8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-headings {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 8px;
    padding: 4px 0;
    border-bottom: 1px solid var(--background-modifier-border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-excerpt {
    color: var(--text-normal);
    font-size: 13px;
    line-height: 1.6;
    margin-top: 8px;
    overflow-y: auto;
    padding: 8px;
    background: var(--background-primary);
    border-radius: 4px;
    border: 1px solid var(--background-modifier-border);
  }

  .result-excerpt::-webkit-scrollbar {
    width: 6px;
  }

  .result-excerpt::-webkit-scrollbar-track {
    background: transparent;
  }

  .result-excerpt::-webkit-scrollbar-thumb {
    background: var(--background-modifier-border);
    border-radius: 3px;
  }

  .result-excerpt::-webkit-scrollbar-thumb:hover {
    background: var(--text-muted);
  }
</style>
