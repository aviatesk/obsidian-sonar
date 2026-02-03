<script lang="ts">
  import { App, Notice } from 'obsidian';
  import type { Writable } from 'svelte/store';
  import type { ConfigManager } from '../ConfigManager';
  import type { ChatTurn } from '../ChatManager';
  import type { ToolConfig, ToolPermissionRequest } from '../tools';
  import { MarkdownRenderingManager } from './MarkdownRenderingManager';
  import { isSendShortcut } from './ChatView';
  import { onDestroy, tick, untrack } from 'svelte';
  import { Copy, Pencil, RefreshCw, Trash2, Wrench, createElement } from 'lucide';

  type ProcessingPhase =
    | { type: 'calling_tool'; toolName: string }
    | { type: 'awaiting_permission'; request: ToolPermissionRequest }
    | { type: 'generating' };

  interface ChatViewState {
    status: 'initializing' | 'ready' | 'processing' | 'error';
    history: ChatTurn[];
    errorMessage: string | null;
    streamingContent: string;
    pendingUserMessage: string | null;
    enableThinking: boolean;
    tools: ToolConfig[];
    processingPhase: ProcessingPhase | null;
    modelName: string;
  }

  interface Props {
    app: App;
    configManager: ConfigManager;
    store: Writable<ChatViewState>;
    onClearHistory: () => void;
    onToggleThinking: () => void;
    onToggleTool: (toolName: string) => void;
    onReloadExtensionTools: () => void;
    onHoverLink: (event: MouseEvent, linktext: string) => void;
    onDeleteTurn: (index: number) => void;
    onEditTurn: (index: number, message: string) => void;
    onPermissionResponse: (permitted: boolean) => void;
  }

  let { app, configManager, store, onClearHistory, onToggleThinking, onToggleTool, onReloadExtensionTools, onHoverLink, onDeleteTurn, onEditTurn, onPermissionResponse }: Props = $props();

  let editingIndex = $state<number | null>(null);
  let editingText = $state('');
  let toolsExpanded = $state(false);

  let messagesContainer: HTMLElement;

  // Use a different class from SemanticNoteFinder's 'result-excerpt-markdown'
  // to avoid inheriting its margin-resetting styles
  const markdownManager = untrack(
    () =>
      new MarkdownRenderingManager(app, configManager, {
        cssClass: 'chat-result-excerpt-markdown',
      })
  );

  onDestroy(() => {
    markdownManager.cleanup();
  });

  function setMessageElement(node: HTMLElement, content: string) {
    function render(text: string) {
      requestAnimationFrame(() => {
        if (node.parentElement) {
          node.empty();
          markdownManager.render(text, node, '');
        }
      });
    }
    render(content);
    return {
      update(newContent: string) {
        render(newContent);
      },
      destroy() {
        markdownManager.cleanupElement(node);
      },
    };
  }

  function setupInternalLinkHandler(node: HTMLElement) {
    function handleClick(event: MouseEvent) {
      const target = event.target as HTMLElement;
      const link = target.closest('a.internal-link');
      if (link) {
        event.preventDefault();
        const href = link.getAttribute('href');
        if (href) {
          app.workspace.openLinkText(href, '', false);
        }
      }
    }

    function handleMouseover(event: MouseEvent) {
      const target = event.target as HTMLElement;
      const link = target.closest('a.internal-link');
      if (link) {
        const href = link.getAttribute('href');
        if (href) {
          onHoverLink(event, href);
        }
      }
    }

    node.addEventListener('click', handleClick);
    node.addEventListener('mouseover', handleMouseover);
    return {
      destroy() {
        node.removeEventListener('click', handleClick);
        node.removeEventListener('mouseover', handleMouseover);
      },
    };
  }

  let autoScrollEnabled = $state(true);

  function isAtBottom(): boolean {
    if (!messagesContainer) return true;
    const threshold = 20;
    return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  }

  function scrollToBottom() {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  function handleScroll() {
    autoScrollEnabled = isAtBottom();
  }

  // Preserve scroll position across status transitions
  let prevStatus: string | null = null;

  // Before DOM updates: save scroll position and schedule restoration
  $effect.pre(() => {
    const currentStatus = $store.status;
    if (prevStatus === 'processing' && currentStatus === 'ready' && !autoScrollEnabled) {
      const scrollTop = messagesContainer?.scrollTop;
      if (scrollTop !== undefined) {
        // Schedule scroll restoration after DOM updates
        tick().then(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (messagesContainer) {
                messagesContainer.scrollTop = scrollTop;
              }
            });
          });
        });
      }
    }
    prevStatus = currentStatus;
  });

  $effect(() => {
    // Auto-scroll only during streaming, not after generation completes
    if ($store.streamingContent && autoScrollEnabled) {
      setTimeout(scrollToBottom, 0);
    }
  });

  function getStatusText(status: ChatViewState['status']): string {
    switch (status) {
      case 'initializing':
        return 'Initializing...';
      case 'processing':
        return 'Thinking...';
      case 'error':
        return 'Error';
      default:
        return '';
    }
  }

  function setupIcon(node: HTMLElement, IconComponent: typeof Copy) {
    const icon = createElement(IconComponent);
    icon.setAttribute('width', '14');
    icon.setAttribute('height', '14');
    node.appendChild(icon);
  }

  async function handleCopy(text: string) {
    await navigator.clipboard.writeText(text);
    new Notice('Copied to clipboard');
  }

  function handleDelete(index: number) {
    onDeleteTurn(index);
  }

  function startEditing(index: number, text: string) {
    editingIndex = index;
    editingText = text;
  }

  function cancelEditing() {
    editingIndex = null;
    editingText = '';
  }

  function submitEdit(index: number) {
    if (editingText.trim()) {
      onEditTurn(index, editingText.trim());
    }
    editingIndex = null;
    editingText = '';
  }

  function handleEditKeydown(event: KeyboardEvent, index: number) {
    if (isSendShortcut(event)) {
      event.preventDefault();
      submitEdit(index);
    } else if (event.key === 'Escape') {
      cancelEditing();
    }
  }

  function hasEnabledTools(): boolean {
    return $store.tools.some(t => t.enabled && !t.unavailableReason);
  }

  function getEnabledToolCount(): number {
    return $store.tools.filter(t => t.enabled && !t.unavailableReason).length;
  }

  function getToolTooltip(tool: ToolConfig): string {
    if (tool.unavailableReason) {
      return `${tool.description}\n\n⚠ Unavailable: ${tool.unavailableReason}`;
    }
    return tool.description;
  }

  function handleToolClick(tool: ToolConfig): void {
    // Don't toggle unavailable tools
    if (tool.unavailableReason) return;
    onToggleTool(tool.name);
  }

  function toggleToolsExpanded(): void {
    toolsExpanded = !toolsExpanded;
  }

  function getBuiltinTools(): ToolConfig[] {
    return $store.tools.filter(t => t.isBuiltin);
  }

  function getExtensionTools(): ToolConfig[] {
    return $store.tools.filter(t => !t.isBuiltin);
  }
</script>

<div class="rag-view">
  <div class="rag-header">
    <div class="header-left">
      {#if $store.modelName}
        <h3 class="model-name">{$store.modelName}</h3>
      {/if}
      {#if $store.tools.length > 0}
        <button class="tools-header" onclick={toggleToolsExpanded}>
          <span class="tools-icon" use:setupIcon={Wrench}></span>
          <span class="tools-label">Tools</span>
          <span class="tools-count">{getEnabledToolCount()}/{$store.tools.length}</span>
          <span class="tools-chevron" class:expanded={toolsExpanded}>▸</span>
        </button>
      {/if}
    </div>
    <div class="header-controls">
      <button
        class="context-toggle"
        class:active={$store.enableThinking}
        onclick={onToggleThinking}
        title={$store.enableThinking ? 'Thinking mode enabled' : 'Thinking mode disabled'}
      >
        Think
      </button>
      {#if $store.history.length > 0}
        <button
          class="clear-button"
          onclick={onClearHistory}
          title="Clear conversation"
        >
          Clear
        </button>
      {/if}
    </div>
  </div>

  {#if $store.tools.length > 0 && toolsExpanded}
    <div class="tools-bar">
      {#if getBuiltinTools().length > 0}
        <div class="tools-group">
          <span class="tools-group-label">Built-in</span>
          <div class="tools-list">
            {#each getBuiltinTools() as tool (tool.name)}
              <button
                class="tool-toggle"
                class:active={tool.enabled && !tool.unavailableReason}
                class:unavailable={!!tool.unavailableReason}
                onclick={() => handleToolClick(tool)}
                title={getToolTooltip(tool)}
              >
                {tool.displayName}
              </button>
            {/each}
          </div>
        </div>
      {/if}
      <div class="tools-group">
        <span class="tools-group-label">Extensions</span>
        <div class="tools-list">
          {#each getExtensionTools() as tool (tool.name)}
            <button
              class="tool-toggle"
              class:active={tool.enabled && !tool.unavailableReason}
              class:unavailable={!!tool.unavailableReason}
              onclick={() => handleToolClick(tool)}
              title={getToolTooltip(tool)}
            >
              {tool.displayName}
            </button>
          {/each}
          <button
            class="tool-reload"
            onclick={onReloadExtensionTools}
            title="Reload extension tools"
          >
            <span use:setupIcon={RefreshCw}></span>
          </button>
        </div>
      </div>
    </div>
  {/if}

  <div
    class="messages-container"
    bind:this={messagesContainer}
    use:setupInternalLinkHandler
    onscroll={handleScroll}
    role="log"
  >
    {#if $store.history.length === 0 && !$store.pendingUserMessage}
      <div class="empty-state">
        {#if $store.status === 'initializing'}
          <p class="thinking-indicator">Initializing...</p>
          <p class="hint">Waiting for Sonar to initialize. This may take a moment if models are being downloaded.</p>
        {:else if hasEnabledTools()}
          <p>Ask a question about your notes.</p>
          <p class="hint">Context will be retrieved using enabled tools.</p>
        {:else}
          <p>Ask a question.</p>
          <p class="hint">Enable tools above or use [[note]] to include specific notes as context.</p>
        {/if}
      </div>
    {:else}
      {#each $store.history as turn, index (`turn-${index}`)}
        <div class="message user-message">
          {#if editingIndex === index}
            <div class="edit-container">
              <textarea
                class="edit-input"
                bind:value={editingText}
                onkeydown={(e) => handleEditKeydown(e, index)}
              ></textarea>
              <div class="edit-actions">
                <button class="edit-submit" onclick={() => submitEdit(index)}>Send</button>
                <button class="edit-cancel" onclick={cancelEditing}>Cancel</button>
              </div>
            </div>
          {:else}
            <div class="message-row">
              <div class="message-actions" class:disabled={$store.status === 'processing'}>
                <button
                  class="action-btn"
                  title="Delete"
                  onclick={() => handleDelete(index)}
                  disabled={$store.status === 'processing'}
                >
                  <span use:setupIcon={Trash2}></span>
                </button>
                <button
                  class="action-btn"
                  title="Edit"
                  onclick={() => startEditing(index, turn.userMessage)}
                  disabled={$store.status === 'processing'}
                >
                  <span use:setupIcon={Pencil}></span>
                </button>
                <button
                  class="action-btn"
                  title="Copy"
                  onclick={() => handleCopy(turn.userMessage)}
                  disabled={$store.status === 'processing'}
                >
                  <span use:setupIcon={Copy}></span>
                </button>
              </div>
              <div class="message-content" use:setMessageElement={turn.userMessage}></div>
            </div>
          {/if}
        </div>
        <div class="message assistant-message">
          <div class="message-row">
            <div class="message-content" use:setMessageElement={turn.assistantMessage}></div>
            <div class="message-actions" class:disabled={$store.status === 'processing'}>
              <button
                class="action-btn"
                title="Copy"
                onclick={() => handleCopy(turn.assistantMessage)}
                disabled={$store.status === 'processing'}
              >
                <span use:setupIcon={Copy}></span>
              </button>
            </div>
          </div>
        </div>
      {/each}
    {/if}

    {#if $store.pendingUserMessage}
      <div class="message user-message">
        <div class="message-row">
          <div class="message-actions disabled">
            <button class="action-btn" disabled aria-label="Delete">
              <span use:setupIcon={Trash2}></span>
            </button>
            <button class="action-btn" disabled aria-label="Edit">
              <span use:setupIcon={Pencil}></span>
            </button>
            <button class="action-btn" disabled aria-label="Copy">
              <span use:setupIcon={Copy}></span>
            </button>
          </div>
          <div class="message-content" use:setMessageElement={$store.pendingUserMessage}></div>
        </div>
      </div>
    {/if}

    {#if $store.status === 'processing'}
      <div class="message assistant-message processing">
        <div class="message-row">
          <div class="message-content">
            {#if $store.streamingContent}
              <span class="streaming-text" use:setMessageElement={$store.streamingContent}></span>
              <span class="cursor-blink">|</span>
            {:else if $store.processingPhase?.type === 'calling_tool'}
              <span class="thinking-indicator">Calling {$store.processingPhase.toolName}...</span>
            {:else if $store.processingPhase?.type === 'awaiting_permission'}
              <div class="permission-request">
                <div class="permission-header">Allow {$store.processingPhase.request.displayName}?</div>
                <pre class="permission-args">{JSON.stringify($store.processingPhase.request.args, null, 2)}</pre>
                <div class="permission-buttons">
                  <button class="mod-warning" onclick={() => onPermissionResponse(false)}>Deny</button>
                  <button class="mod-cta" onclick={() => onPermissionResponse(true)}>Allow</button>
                </div>
              </div>
            {:else}
              <span class="thinking-indicator">Generating...</span>
            {/if}
          </div>
          <div class="message-actions disabled">
            <button class="action-btn" disabled aria-label="Copy">
              <span use:setupIcon={Copy}></span>
            </button>
          </div>
        </div>
      </div>
    {/if}

    {#if $store.errorMessage}
      <div class="error-message">
        Error: {$store.errorMessage}
      </div>
    {/if}
  </div>

  {#if $store.status !== 'ready' && $store.status !== 'error'}
    <div class="status-bar">
      {getStatusText($store.status)}
    </div>
  {/if}
</div>

<style>
  .rag-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 16px;
    overflow: hidden;
  }

  .rag-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    position: relative;
    z-index: 10;
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .rag-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .model-name {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 400;
  }

  .header-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .tools-header {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
  }

  .tools-header:hover {
    color: var(--text-normal);
    background: var(--background-modifier-hover);
  }

  .tools-icon {
    display: flex;
    align-items: center;
  }

  .tools-icon :global(svg) {
    width: 12px;
    height: 12px;
  }

  .tools-label {
    font-size: 11px;
  }

  .tools-count {
    font-size: 10px;
    color: var(--text-faint);
  }

  .tools-chevron {
    font-size: 10px;
    transition: transform 0.15s ease;
  }

  .tools-chevron.expanded {
    transform: rotate(90deg);
  }

  .tools-bar {
    position: relative;
    z-index: 1;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .tools-group {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .tools-group-label {
    font-size: 9px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding-top: 4px;
    min-width: 55px;
    flex-shrink: 0;
  }

  .tools-list {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .tool-toggle {
    padding: 3px 8px;
    font-size: 10px;
    font-weight: 500;
    background: var(--background-modifier-border);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-muted);
    transition: all 0.15s ease;
  }

  .tool-toggle:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .tool-toggle.active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .tool-toggle.active:hover {
    background: var(--interactive-accent-hover);
  }

  .tool-toggle.unavailable {
    opacity: 0.5;
    cursor: not-allowed;
    text-decoration: line-through;
  }

  .tool-toggle.unavailable:hover {
    background: var(--background-modifier-border);
    color: var(--text-muted);
  }

  .tool-reload {
    padding: 3px 6px;
    background: transparent;
    border: 1px dashed var(--background-modifier-border);
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .tool-reload:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
    border-color: var(--text-muted);
  }

  .tool-reload :global(svg) {
    width: 12px;
    height: 12px;
  }

  .context-toggle {
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 600;
    background: var(--background-modifier-border);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-muted);
    transition: all 0.15s ease;
  }

  .context-toggle:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .context-toggle.active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .context-toggle.active:hover {
    background: var(--interactive-accent-hover);
  }

  .clear-button {
    padding: 4px 12px;
    font-size: 12px;
    background: var(--background-modifier-border);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-muted);
  }

  .clear-button:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .messages-container {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin-bottom: 16px;
    padding-right: 8px;
  }

  .empty-state {
    text-align: center;
    padding: 32px;
    color: var(--text-muted);
  }

  .empty-state p {
    margin: 8px 0;
  }

  .empty-state .hint {
    font-size: 12px;
    opacity: 0.8;
  }

  .message {
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
  }

  .user-message {
    align-items: flex-end;
  }

  .user-message .message-content {
    background: var(--background-primary-alt);
    padding: 10px 14px;
    border-radius: 16px 16px 4px 16px;
    border: 1px solid var(--interactive-accent);
    user-select: text;
    cursor: text;
  }

  .assistant-message {
    align-items: flex-start;
  }

  .assistant-message .message-content {
    background: var(--background-secondary);
    padding: 10px 14px;
    border-radius: 16px 16px 16px 4px;
    border: 1px solid var(--background-modifier-border);
  }

  .message-content {
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-normal);
    user-select: text;
    cursor: text;
  }

  .message-content :global(p) {
    margin: 0 0 8px 0;
  }

  .message-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .processing .message-content {
    background: var(--background-secondary);
    padding: 10px 14px;
    border-radius: 16px 16px 16px 4px;
    border: 1px solid var(--background-modifier-border);
  }

  .thinking-indicator {
    display: inline-block;
    color: var(--text-muted);
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .streaming-text {
    display: inline;
  }

  .cursor-blink {
    animation: blink 1s step-end infinite;
    font-weight: bold;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .error-message {
    padding: 12px;
    margin-bottom: 16px;
    background: rgba(255, 0, 0, 0.1);
    border: 1px solid rgba(255, 0, 0, 0.3);
    border-radius: 8px;
    color: var(--text-error);
    font-size: 13px;
  }

  .status-bar {
    margin-top: 8px;
    padding: 8px;
    text-align: center;
    font-size: 12px;
    color: var(--text-muted);
    background: var(--background-secondary);
    border-radius: 4px;
  }

  .messages-container::-webkit-scrollbar {
    width: 8px;
  }

  .messages-container::-webkit-scrollbar-track {
    background: transparent;
  }

  .messages-container::-webkit-scrollbar-thumb {
    background: var(--background-modifier-border);
    border-radius: 4px;
  }

  .messages-container::-webkit-scrollbar-thumb:hover {
    background: var(--text-muted);
  }

  .message-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .user-message .message-row {
    flex-direction: row;
  }

  .assistant-message .message-row {
    flex-direction: row;
  }

  .message-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s ease;
    flex-shrink: 0;
    align-items: center;
  }

  .message:hover .message-actions:not(.disabled) {
    opacity: 1;
  }

  .message-actions.disabled {
    pointer-events: none;
  }

  .action-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .action-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .edit-container {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 90%;
  }

  .edit-input {
    width: 100%;
    min-height: 60px;
    padding: 10px 14px;
    border: 1px solid var(--interactive-accent);
    border-radius: 8px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: 14px;
    line-height: 1.5;
    resize: vertical;
  }

  .edit-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
  }

  .edit-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .edit-submit {
    padding: 6px 16px;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
  }

  .edit-submit:hover {
    background: var(--interactive-accent-hover);
  }

  .edit-cancel {
    padding: 6px 16px;
    background: var(--background-modifier-border);
    color: var(--text-muted);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }

  .edit-cancel:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .permission-request {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .permission-header {
    font-weight: 600;
  }

  .permission-args {
    background: var(--background-primary);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
    margin: 0;
    overflow-x: auto;
    max-height: 150px;
    overflow-y: auto;
  }

  .permission-buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-start;
  }

  .permission-buttons button {
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    flex-shrink: 0;
  }
</style>
