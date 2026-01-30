import { HoverPopover, ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { mount, unmount } from 'svelte';
import { writable, get } from 'svelte/store';
import { Mic, Square, createElement } from 'lucide';
import { sonarState, type SonarModelState } from '../SonarModelState';
import type { ConfigManager } from '../ConfigManager';
import type { ChatTurn } from '../ChatManager';
import type { ToolConfig, ToolPermissionRequest } from '../tools';
import { createComponentLogger, type ComponentLogger } from '../WithLogging';
import ChatViewContent from './ChatViewContent.svelte';
import { FileSuggestModal, getWikilinkForFile } from './FileSuggestModal';
import type SonarPlugin from '../../main';
import {
  VoiceRecorder,
  deleteTempFile,
  type RecordingState,
} from '../VoiceRecorder';
import { transcribeAudio, type AudioTranscriptionConfig } from '../audio';

export const CHAT_VIEW_TYPE = 'chat-view';

/**
 * Check if keyboard event matches the send shortcut (Cmd+Ctrl+Enter)
 */
export function isSendShortcut(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && e.metaKey && e.ctrlKey && !e.isComposing;
}

export type ChatViewStatus = 'initializing' | 'ready' | 'processing' | 'error';

type ProcessingPhase =
  | { type: 'calling_tool'; toolName: string }
  | { type: 'awaiting_permission'; request: ToolPermissionRequest }
  | { type: 'generating' };

interface ChatViewState {
  status: ChatViewStatus;
  history: ChatTurn[];
  errorMessage: string | null;
  streamingContent: string;
  pendingUserMessage: string | null;
  enableThinking: boolean;
  tools: ToolConfig[];
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
  private permissionResolver: ((permitted: boolean) => void) | null = null;

  private chatViewStore = writable<ChatViewState>({
    status: 'initializing',
    history: [],
    errorMessage: null,
    streamingContent: '',
    pendingUserMessage: null,
    enableThinking: false,
    tools: [],
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
      enableThinking: this.configManager.get('chatEnableThinking'),
      modelName: this.getShortModelName(),
    });

    this.mountComponent();
    this.createInputArea();
    this.registerKeyboardShortcuts();
    this.setupSonarStateSubscription();
  }

  private setupSonarStateSubscription(): void {
    let previousState: SonarModelState | null = null;

    this.sonarStateUnsubscribe = sonarState.subscribe(state => {
      if (state.embedder === 'failed') {
        this.updateStore({
          status: 'error',
          errorMessage:
            'Sonar initialization failed. Check llama.cpp configuration in Settings → Sonar, then run Reinitialize Sonar.',
        });
      } else if (state.embedder === 'ready') {
        // Try to initialize chat model when embedder becomes ready
        if (previousState?.embedder !== 'ready') {
          this.tryInitializeChatModel();
        }
      }

      previousState = state;
    });
  }

  private async tryInitializeChatModel(): Promise<void> {
    const result = await this.plugin.initializeChatModelLazy();
    if (result === 'ready') {
      const currentState = get(this.chatViewStore);
      this.updateStore({
        status: 'ready',
        history: [],
        tools: this.getToolConfigs(),
        enableThinking: currentState.enableThinking,
        modelName: this.getShortModelName(),
      });
    } else if (result === 'failed') {
      this.updateStore({
        status: 'error',
        errorMessage:
          'Failed to initialize chat model. Check llama.cpp configuration in Settings → Sonar, then run Reinitialize Sonar.',
      });
    }
    // If 'pending', keep 'initializing' state and wait for embedder to become ready
  }

  private getToolConfigs(): ToolConfig[] {
    const registry = this.plugin.chatManager?.getToolRegistry();
    return registry?.getToolConfigs() ?? [];
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
        onToggleThinking: () => this.handleToggleThinking(),
        onToggleTool: (toolName: string) => this.handleToggleTool(toolName),
        onReloadExtensionTools: () => this.handleReloadExtensionTools(),
        onHoverLink: (event: MouseEvent, linktext: string) =>
          this.handleHoverLink(event, linktext),
        onDeleteTurn: (index: number) => this.handleDeleteTurn(index),
        onEditTurn: (index: number, message: string) =>
          this.handleEditTurn(index, message),
        onPermissionResponse: (permitted: boolean) =>
          this.handlePermissionResponse(permitted),
      },
    });
  }

  private handleToggleThinking(): void {
    const currentValue = this.configManager.get('chatEnableThinking');
    const newValue = !currentValue;
    this.configManager.set('chatEnableThinking', newValue);
    this.updateStore({ enableThinking: newValue });
  }

  private handlePermissionResponse(permitted: boolean): void {
    if (this.permissionResolver) {
      this.permissionResolver(permitted);
      this.permissionResolver = null;
      this.updateStore({
        processingPhase: { type: 'generating' },
      });
    }
  }

  private handleToggleTool(toolName: string): void {
    const registry = this.plugin.chatManager?.getToolRegistry();
    if (!registry) return;

    registry.toggle(toolName);
    this.updateStore({ tools: this.getToolConfigs() });
  }

  private async handleReloadExtensionTools(): Promise<void> {
    const count = await this.plugin.reloadExtensionTools();
    this.updateStore({ tools: this.getToolConfigs() });
    new Notice(`Reloaded ${count} extension tools`);
  }

  private handleCancel(): void {
    if (this.abortController) {
      this.logger.log('Cancelling generation...');
      // Resolve pending permission request as denied before aborting
      if (this.permissionResolver) {
        this.permissionResolver(false);
        this.permissionResolver = null;
      }
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
  private recordButton: HTMLButtonElement | null = null;
  private voiceRecorder: VoiceRecorder | null = null;
  private autoSendOnStop = false;
  private storeUnsubscribe: (() => void) | null = null;
  private sonarStateUnsubscribe: (() => void) | null = null;

  private createInputArea(): void {
    const inputContainer = this.contentEl.createDiv('rag-input-container');

    this.inputEl = document.createElement('textarea');
    this.inputEl.className = 'rag-message-input';
    this.inputEl.rows = 1;
    this.inputEl.placeholder = 'Ask a question... (Cmd+Ctrl+Enter to send)';

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

    // Only show voice recording button if whisper is configured
    if (this.configManager.get('audioWhisperModelPath')) {
      this.recordButton = inputContainer.createEl('button', {
        cls: 'rag-record-button',
      });
      this.setRecordButtonIcon('mic');
      this.recordButton.title =
        'Record voice message (Cmd+click to send immediately)';
      this.recordButton.addEventListener('click', e =>
        this.handleRecordClick(e)
      );
      this.voiceRecorder = new VoiceRecorder({
        onStateChange: state => this.updateRecordButtonState(state),
        onError: error => {
          this.logger.error(`Voice recording error: ${error.message}`);
          new Notice(`Voice recording failed: ${error.message}`);
        },
      });
    }

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

    // Subscribe to store to update button state
    this.storeUnsubscribe = this.chatViewStore.subscribe(state => {
      if (this.sendButton) {
        const isProcessing = state.status === 'processing';
        this.sendButton.textContent = isProcessing ? '' : 'Send';
        this.sendButton.classList.toggle('is-loading', isProcessing);
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
    if (!this.plugin.chatManager) {
      this.logger.error('Chat not initialized');
      this.updateStore({
        status: 'error',
        errorMessage: 'Chat not initialized',
      });
      return;
    }

    this.abortController = new AbortController();

    this.updateStore({
      status: 'processing',
      streamingContent: '',
      pendingUserMessage: message,
      processingPhase: { type: 'generating' },
      errorMessage: null,
    });

    try {
      await this.plugin.chatManager.chatStream(
        message,
        delta => {
          const currentState = get(this.chatViewStore);
          this.updateStore({
            streamingContent: currentState.streamingContent + delta.content,
            processingPhase: { type: 'generating' },
          });
        },
        (toolName: string, phase: 'calling' | 'done') => {
          if (phase === 'calling') {
            this.updateStore({
              processingPhase: { type: 'calling_tool', toolName },
            });
          } else {
            this.updateStore({
              processingPhase: { type: 'generating' },
            });
          }
        },
        async request => {
          return new Promise<boolean>(resolve => {
            this.permissionResolver = resolve;
            this.updateStore({
              processingPhase: {
                type: 'awaiting_permission',
                request,
              },
            });
          });
        },
        this.abortController.signal
      );

      this.updateStore({
        status: 'ready',
        history: this.plugin.chatManager.getHistory(),
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
    if (this.plugin.chatManager) {
      this.plugin.chatManager.clear();
      this.updateStore({
        history: [],
        errorMessage: null,
      });
    }
  }

  private handleDeleteTurn(index: number): void {
    if (this.plugin.chatManager) {
      this.plugin.chatManager.deleteTurn(index);
      this.updateStore({
        history: this.plugin.chatManager.getHistory(),
      });
    }
  }

  private handleEditTurn(index: number, message: string): void {
    if (!this.plugin.chatManager) return;
    // Truncate history to the turn being edited
    this.plugin.chatManager.truncateHistory(index);
    this.updateStore({
      history: this.plugin.chatManager.getHistory(),
    });
    this.handleSendMessage(message);
  }

  private setRecordButtonIcon(iconType: 'mic' | 'stop' | 'none'): void {
    if (!this.recordButton) return;
    this.recordButton.empty();
    if (iconType === 'none') return;
    const IconComponent = iconType === 'mic' ? Mic : Square;
    this.recordButton.appendChild(createElement(IconComponent));
  }

  private updateRecordButtonState(state: RecordingState): void {
    if (!this.recordButton) return;

    this.recordButton.classList.toggle('is-recording', state === 'recording');
    this.recordButton.classList.toggle('is-processing', state === 'processing');

    if (state === 'recording') {
      this.setRecordButtonIcon('stop');
      this.recordButton.title = this.autoSendOnStop
        ? 'Stop and send immediately'
        : 'Stop recording';
    } else if (state === 'processing') {
      this.setRecordButtonIcon('none');
      this.recordButton.title = 'Transcribing...';
    } else {
      this.setRecordButtonIcon('mic');
      this.recordButton.title =
        'Record voice message (Cmd+click to send immediately)';
    }
  }

  private async handleRecordClick(event: MouseEvent): Promise<void> {
    if (!this.voiceRecorder) return;

    const state = this.voiceRecorder.getState();

    if (state === 'idle') {
      this.autoSendOnStop = event.metaKey;
      await this.voiceRecorder.startRecording();
    } else if (state === 'recording') {
      await this.handleStopRecording();
    }
    // Ignore clicks while processing
  }

  private async handleStopRecording(): Promise<void> {
    if (!this.voiceRecorder) return;

    const shouldAutoSend = this.autoSendOnStop;
    this.autoSendOnStop = false;

    const tempPath = await this.voiceRecorder.stopRecording();
    if (!tempPath) return;

    try {
      const config = this.getAudioConfig();
      if (!config.whisperModelPath) {
        new Notice('Whisper model path not configured. Check settings.');
        return;
      }

      const result = await transcribeAudio(tempPath, {
        config,
        logger: this.logger,
      });

      if (result.text && this.inputEl) {
        // Append to existing input (in case user typed something)
        const existingText = this.inputEl.value;
        const separator =
          existingText && !existingText.endsWith(' ') ? ' ' : '';
        this.inputEl.value = existingText + separator + result.text;
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;

        if (shouldAutoSend) {
          this.submitMessage();
        } else {
          this.inputEl.focus();
        }
      }
    } catch (error) {
      this.logger.error(`Transcription failed: ${error}`);
      new Notice(
        `Transcription failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      deleteTempFile(tempPath);
    }
  }

  private getAudioConfig(): AudioTranscriptionConfig {
    return {
      whisperCliPath: this.configManager.get('audioWhisperCliPath'),
      whisperModelPath: this.configManager.get('audioWhisperModelPath'),
      ffmpegPath: this.configManager.get('audioFfmpegPath'),
      language: this.configManager.get('audioTranscriptionLanguage'),
    };
  }

  async onClose(): Promise<void> {
    this.unregisterKeyboardShortcuts();
    if (this.voiceRecorder) {
      this.voiceRecorder.cancelRecording();
      this.voiceRecorder = null;
    }
    if (this.sonarStateUnsubscribe) {
      this.sonarStateUnsubscribe();
      this.sonarStateUnsubscribe = null;
    }
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
