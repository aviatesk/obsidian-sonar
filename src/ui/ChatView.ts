import { HoverPopover, ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import { mount, unmount } from 'svelte';
import { writable, get } from 'svelte/store';
import type { ConfigManager } from '../ConfigManager';
import type { ChatTurn } from '../Chat';
import { createComponentLogger, type ComponentLogger } from '../WithLogging';
import ChatViewContent from './ChatViewContent.svelte';
import { FileSuggestModal, getWikilinkForFile } from './FileSuggestModal';
import type SonarPlugin from '../../main';

export const CHAT_VIEW_TYPE = 'chat-view';

/**
 * Check if keyboard event matches the send shortcut (Cmd+Ctrl+Enter)
 */
export function isSendShortcut(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && e.metaKey && e.ctrlKey && !e.isComposing;
}

export type ChatViewStatus = 'initializing' | 'ready' | 'processing' | 'error';

type ProcessingPhase = 'retrieving' | 'generating';

interface ChatViewState {
  status: ChatViewStatus;
  history: ChatTurn[];
  errorMessage: string | null;
  streamingContent: string;
  pendingUserMessage: string | null;
  enableContext: boolean;
  enableThinking: boolean;
  processingPhase: ProcessingPhase | null;
  modelName: string;
}

const COMPONENT_ID = 'ChatView';

export class ChatView extends ItemView {
  private plugin: SonarPlugin;
  private configManager: ConfigManager;
  private logger: ComponentLogger;
  private svelteComponent: ReturnType<typeof mount> | null = null;
  hoverPopover: HoverPopover | null = null; // HoverParent interface
  private abortController: AbortController | null = null;

  private chatViewStore = writable<ChatViewState>({
    status: 'initializing',
    history: [],
    errorMessage: null,
    streamingContent: '',
    pendingUserMessage: null,
    enableContext: true,
    enableThinking: false,
    processingPhase: null,
    modelName: '',
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
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Chat';
  }

  getIcon(): string {
    return 'message-circle';
  }

  /**
   * Extract a short model name from the config
   * e.g., 'qwen3-8b-q8_0.gguf' -> 'Qwen3-8B'
   */
  private getShortModelName(): string {
    const modelFile = this.configManager.get('llamaChatModelFile');
    // Remove .gguf extension and quantization suffix (e.g., -q8_0, -Q4_K_M)
    const baseName = modelFile
      .replace(/\.gguf$/i, '')
      .replace(/[-_][qQ]\d+[_]?\d*[_]?[a-zA-Z]*$/i, '');
    // Capitalize first letter of each segment for readability
    return baseName
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('-');
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('rag-view-container');

    this.updateStore({
      enableContext: this.configManager.get('ragEnableContext'),
      enableThinking: this.configManager.get('chatEnableThinking'),
      modelName: this.getShortModelName(),
    });

    this.mountComponent();
    this.createInputArea();
    this.registerKeyboardShortcuts();

    // Lazy-load chat model when view is opened
    const result = await this.plugin.initializeChatModelLazy();
    if (result === 'ready') {
      this.updateStore({ status: 'ready' });
    } else if (result === 'failed') {
      this.updateStore({
        status: 'error',
        errorMessage: 'Failed to initialize chat model',
      });
    }
    // If 'pending', keep 'initializing' state and wait for onSonarInitialized
  }

  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  private registerKeyboardShortcuts(): void {
    // Cmd+Ctrl+Enter to send (Cmd+Enter alone is captured by Obsidian on Mac)
    this.keydownHandler = (e: KeyboardEvent) => {
      if (
        isSendShortcut(e) &&
        this.inputEl &&
        document.activeElement === this.inputEl
      ) {
        e.preventDefault();
        this.submitMessage();
      }
    };
    document.addEventListener('keydown', this.keydownHandler, {
      capture: true,
    });
  }

  private unregisterKeyboardShortcuts(): void {
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler, {
        capture: true,
      });
      this.keydownHandler = null;
    }
  }

  private mountComponent(): void {
    const messagesContainer = this.contentEl.createDiv('rag-messages-wrapper');

    this.svelteComponent = mount(ChatViewContent, {
      target: messagesContainer,
      props: {
        app: this.app,
        configManager: this.configManager,
        store: this.chatViewStore,
        onClearHistory: () => this.handleClearHistory(),
        onToggleContext: () => this.handleToggleContext(),
        onToggleThinking: () => this.handleToggleThinking(),
        onHoverLink: (event: MouseEvent, linktext: string) =>
          this.handleHoverLink(event, linktext),
        onDeleteTurn: (index: number) => this.handleDeleteTurn(index),
        onEditTurn: (index: number, message: string) =>
          this.handleEditTurn(index, message),
      },
    });
  }

  private handleToggleContext(): void {
    const currentValue = this.configManager.get('ragEnableContext');
    const newValue = !currentValue;
    this.configManager.set('ragEnableContext', newValue);
    this.updateStore({ enableContext: newValue });
  }

  private handleToggleThinking(): void {
    const currentValue = this.configManager.get('chatEnableThinking');
    const newValue = !currentValue;
    this.configManager.set('chatEnableThinking', newValue);
    this.updateStore({ enableThinking: newValue });
  }

  private handleCancel(): void {
    if (this.abortController) {
      this.logger.log('Cancelling generation...');
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private handleHoverLink(event: MouseEvent, linktext: string): void {
    this.app.workspace.trigger('hover-link', {
      event,
      source: CHAT_VIEW_TYPE,
      hoverParent: this,
      targetEl: event.target as HTMLElement,
      linktext,
      sourcePath: '',
    });
  }

  private inputEl: HTMLTextAreaElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private storeUnsubscribe: (() => void) | null = null;

  private createInputArea(): void {
    const inputContainer = this.contentEl.createDiv('rag-input-container');

    this.inputEl = document.createElement('textarea');
    this.inputEl.className = 'rag-message-input';
    this.inputEl.rows = 1;

    // Auto-resize textarea based on content and detect wikilink trigger
    this.inputEl.addEventListener('input', e => {
      if (!this.inputEl) return;

      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;

      // Detect `[[` trigger for file autocomplete
      if ((e as InputEvent).data === '[') {
        const cursorPos = this.inputEl.selectionStart;
        const textBefore = this.inputEl.value.slice(0, cursorPos);
        if (textBefore.endsWith('[[')) {
          this.openFileSuggestModal();
        }
      }
    });

    inputContainer.appendChild(this.inputEl);

    this.sendButton = inputContainer.createEl('button', {
      cls: 'rag-send-button',
    });
    this.sendButton.textContent = 'Send';
    this.sendButton.addEventListener('click', () => {
      const currentState = get(this.chatViewStore);
      if (currentState.status === 'processing') {
        this.handleCancel();
      } else {
        this.submitMessage();
      }
    });

    // Subscribe to store to update button and placeholder state
    this.storeUnsubscribe = this.chatViewStore.subscribe(state => {
      if (this.sendButton) {
        const isProcessing = state.status === 'processing';
        this.sendButton.textContent = isProcessing ? '' : 'Send';
        this.sendButton.classList.toggle('is-loading', isProcessing);
      }
      if (this.inputEl) {
        this.inputEl.placeholder = state.enableContext
          ? 'Ask about your notes... (Cmd+Ctrl+Enter to send)'
          : 'Ask a question... (Cmd+Ctrl+Enter to send)';
      }
    });
  }

  private async openFileSuggestModal(): Promise<void> {
    if (!this.plugin.metadataStore) {
      this.logger.warn('MetadataStore not available for file suggestions');
      return;
    }

    // Get unique file paths from indexed chunks
    const chunks = await this.plugin.metadataStore.getAllChunks();
    const filePaths = new Set<string>();
    for (const chunk of chunks) {
      filePaths.add(chunk.filePath);
    }

    // Convert to TFile objects
    const files: TFile[] = [];
    for (const path of filePaths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        files.push(file);
      }
    }

    if (files.length === 0) {
      this.logger.warn('No indexed files found for suggestions');
      return;
    }

    new FileSuggestModal(this.app, files, file => {
      this.insertWikilink(file);
    }).open();
  }

  private insertWikilink(file: TFile): void {
    if (!this.inputEl) return;

    const wikilink = getWikilinkForFile(file);
    const cursorPos = this.inputEl.selectionStart;
    const textBefore = this.inputEl.value.slice(0, cursorPos);
    const textAfter = this.inputEl.value.slice(cursorPos);

    // Insert file name and closing brackets
    this.inputEl.value = textBefore + wikilink + ']]' + textAfter;

    // Move cursor after the closing brackets
    const newPos = cursorPos + wikilink.length + 2;
    this.inputEl.setSelectionRange(newPos, newPos);
    this.inputEl.focus();
  }

  private submitMessage(): void {
    if (!this.inputEl) return;
    // Prevent sending during processing
    const currentState = get(this.chatViewStore);
    if (currentState.status === 'processing') return;

    const message = this.inputEl.value.trim();
    if (message) {
      this.handleSendMessage(message);
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
    }
  }

  private updateStore(partialState: Partial<ChatViewState>): void {
    const currentState = get(this.chatViewStore);
    this.chatViewStore.set({ ...currentState, ...partialState });
  }

  private async handleSendMessage(message: string): Promise<void> {
    if (!this.plugin.chat) {
      this.logger.error('Chat not initialized');
      this.updateStore({
        status: 'error',
        errorMessage: 'Chat not initialized',
      });
      return;
    }

    const enableContext = this.configManager.get('ragEnableContext');
    const initialPhase: ProcessingPhase = enableContext
      ? 'retrieving'
      : 'generating';

    this.abortController = new AbortController();

    this.updateStore({
      status: 'processing',
      streamingContent: '',
      pendingUserMessage: message,
      processingPhase: initialPhase,
      errorMessage: null,
    });

    try {
      await this.plugin.chat.chatStream(
        message,
        delta => {
          const currentState = get(this.chatViewStore);
          this.updateStore({
            streamingContent: currentState.streamingContent + delta.content,
          });
        },
        () => {
          this.updateStore({ processingPhase: 'generating' });
        },
        this.abortController.signal
      );

      this.updateStore({
        status: 'ready',
        history: this.plugin.chat.getHistory(),
        errorMessage: null,
        streamingContent: '',
        pendingUserMessage: null,
        processingPhase: null,
      });
    } catch (error) {
      // Don't show error for user-initiated abort
      if (error instanceof Error && error.name === 'AbortError') {
        // Restore user message to input for re-editing (like edit behavior)
        const cancelledMessage = get(this.chatViewStore).pendingUserMessage;
        this.updateStore({
          status: 'ready',
          errorMessage: null,
          streamingContent: '',
          pendingUserMessage: null,
          processingPhase: null,
        });
        if (this.inputEl && cancelledMessage) {
          this.inputEl.value = cancelledMessage;
          this.inputEl.style.height = 'auto';
          this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
          this.inputEl.focus();
        }
        return;
      }

      this.logger.error(`Chat error: ${error}`);
      this.updateStore({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        streamingContent: '',
        pendingUserMessage: null,
        processingPhase: null,
      });
    } finally {
      this.abortController = null;
    }
  }

  private handleClearHistory(): void {
    if (this.plugin.chat) {
      this.plugin.chat.clear();
      this.updateStore({
        history: [],
        errorMessage: null,
      });
    }
  }

  private handleDeleteTurn(index: number): void {
    if (this.plugin.chat) {
      this.plugin.chat.deleteTurn(index);
      this.updateStore({
        history: this.plugin.chat.getHistory(),
      });
    }
  }

  private handleEditTurn(index: number, message: string): void {
    if (!this.plugin.chat) return;
    // Truncate history to the turn being edited
    this.plugin.chat.truncateHistory(index);
    this.updateStore({
      history: this.plugin.chat.getHistory(),
    });
    this.handleSendMessage(message);
  }

  async onSonarInitialized(): Promise<void> {
    const currentState = get(this.chatViewStore);
    // Retry lazy init if view was opened before Sonar finished initializing
    if (currentState.status === 'initializing') {
      const result = await this.plugin.initializeChatModelLazy();
      switch (result) {
        case 'ready':
          this.updateStore({ status: 'ready', errorMessage: null });
          break;
        case 'failed':
          this.updateStore({
            status: 'error',
            errorMessage: 'Failed to initialize chat model',
          });
          break;
        case 'pending':
          throw new Error(
            'Unexpected pending state: Sonar should be initialized at this point'
          );
      }
    }
  }

  async onClose(): Promise<void> {
    this.unregisterKeyboardShortcuts();
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe();
      this.storeUnsubscribe = null;
    }
    if (this.svelteComponent) {
      unmount(this.svelteComponent);
      this.svelteComponent = null;
    }

    // Cleanup chat model to free memory
    await this.plugin.cleanupChatModel();
  }
}
