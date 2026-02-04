import type { ChildProcess } from 'child_process';
import type { ConfigManager } from './ConfigManager';
import { sonarState } from './SonarState';
import { WithLogging } from './WithLogging';

type ModelStatus = 'uninitialized' | 'initializing' | 'ready' | 'failed';
import {
  isModelCached,
  downloadModel,
  getModelCachePath,
  findAvailablePort,
  killServerProcess,
  startLlamaServer,
  waitForServerReady,
  llamaServerChatCompletionStream,
  llamaServerTokenize,
  llamaServerGetChatTemplateCaps,
  type ChatMessage,
  type ChatMessageExtended,
  type ToolCall,
  type OpenAIToolDefinition,
  type ChatCompletionOptions,
  type ChatStreamDelta,
  type ChatStreamUsage,
  type ChatStreamWithToolsResult,
  type ChatTemplateCaps,
} from './llamaCppUtils';

export type {
  ChatMessage,
  ChatMessageExtended,
  ToolCall,
  OpenAIToolDefinition,
  ChatCompletionOptions,
  ChatStreamDelta,
  ChatStreamUsage,
  ChatStreamWithToolsResult,
};

/**
 * Chat completion using llama.cpp server
 * Manages a llama.cpp server process for chat/LLM inference
 */
export class LlamaCppChat extends WithLogging {
  protected readonly componentName = 'LlamaCppChat';

  private serverProcess: ChildProcess | null = null;
  private port: number | null = null;
  private exitHandlerBound: (() => void) | null = null;
  private _status: ModelStatus = 'uninitialized';
  private _chatTemplateCaps: ChatTemplateCaps | null = null;

  constructor(
    private serverPath: string,
    private modelRepo: string,
    private modelFile: string,
    protected configManager: ConfigManager,
    private showNotice?: (msg: string, duration?: number) => void,
    private confirmDownload?: (modelId: string) => Promise<boolean>
  ) {
    super();
  }

  private updateStatusBar(status: string): void {
    sonarState.setStatusBarText(status);
  }

  private setStatus(status: ModelStatus): void {
    this._status = status;
  }

  get status(): ModelStatus {
    return this._status;
  }

  async initialize(): Promise<void> {
    this.setStatus('initializing');
    try {
      this.log(`Initializing with model: ${this.modelRepo}/${this.modelFile}`);
      this.updateStatusBar('Chat: Initializing...');

      if (!isModelCached(this.modelRepo, this.modelFile)) {
        const modelId = `${this.modelRepo}/${this.modelFile}`;

        // Ask for confirmation before downloading
        if (this.confirmDownload) {
          const confirmed = await this.confirmDownload(modelId);
          if (!confirmed) {
            throw new Error(
              `Download cancelled by user. ` +
                `To use a different model, change the settings and reinitialize.`
            );
          }
        }

        this.log(`Model not found in cache, downloading...`);
        await downloadModel(this.modelRepo, this.modelFile, progress => {
          if (progress.status === 'progress') {
            const percent = progress.percent.toFixed(0);
            this.updateStatusBar(`Chat: Loading ${percent}%`);
          }
        });
        this.log(`Model downloaded`);
      } else {
        this.log(`Using cached model`);
      }

      this.port = await findAvailablePort();
      this.log(`Selected port: ${this.port}`);

      await this.startServer();
      await this.waitForReady();
      this.log(`Initialized on port ${this.port}`);
    } catch (error) {
      this.setStatus('failed');
      throw error;
    }
  }

  private get serverUrl(): string {
    if (!this.port) {
      throw new Error('Server port not initialized');
    }
    return `http://localhost:${this.port}`;
  }

  private async startServer(): Promise<void> {
    if (!this.port) {
      throw new Error('Port not selected');
    }

    const modelPath = getModelCachePath(this.modelRepo, this.modelFile);

    this.log(`Starting llama.cpp chat server (port: ${this.port})...`);

    const args = [
      '--model',
      modelPath,
      '--port',
      this.port.toString(),
      '--ctx-size',
      '32768',
      '--parallel',
      '1',
      '--jinja',
      '-kvu',
      '-lv',
      '0',
    ];

    const result = await startLlamaServer({
      serverPath: this.serverPath,
      args,
      logger: this.configManager.getLogger(),
      showNotice: this.showNotice,
      onExit: () => {
        this.setStatus('failed');
      },
      serverType: 'llama.cpp chat server',
    });

    this.serverProcess = result.process;
    this.exitHandlerBound = result.exitHandler;
  }

  private async waitForReady(): Promise<void> {
    await waitForServerReady(this.serverUrl, this.configManager.getLogger());
    this._chatTemplateCaps = await llamaServerGetChatTemplateCaps(
      this.serverUrl
    );
    if (this._chatTemplateCaps) {
      this.log(
        `Chat template caps: supportsTools=${this._chatTemplateCaps.supportsTools}`
      );
    }
    this.setStatus('ready');
    this.updateStatusBar('Chat: Ready');
  }

  isReady(): boolean {
    return this._status === 'ready';
  }

  /**
   * Check if the loaded model supports tool calling
   * Returns true if capabilities couldn't be determined (assume support)
   */
  supportsTools(): boolean {
    if (!this._chatTemplateCaps) {
      return true; // Assume support if we couldn't get caps
    }
    // Check supports_tool_calls (ability to generate tool calls)
    // supports_tools indicates whether template accepts tool definitions,
    // but supports_tool_calls is what matters for actual tool use
    return this._chatTemplateCaps.supportsToolCalls;
  }

  /**
   * Send a streaming chat completion request with tool support
   * @param messages Array of chat messages (supports extended format with tool messages)
   * @param tools Array of tool definitions in OpenAI format
   * @param options Optional generation parameters
   * @param onDelta Callback for each token delta
   * @param signal Optional AbortSignal for cancellation
   * @returns Promise that resolves to content, tool calls, and usage information
   */
  async chatStream(
    messages: ChatMessageExtended[],
    tools: OpenAIToolDefinition[],
    options: ChatCompletionOptions = {},
    onDelta: (delta: ChatStreamDelta) => void,
    signal?: AbortSignal
  ): Promise<ChatStreamWithToolsResult> {
    if (this._status !== 'ready' || !this.port) {
      throw new Error('Chat server not initialized. Call initialize() first.');
    }

    const topK = this.configManager.get('chatTopK');
    const defaultOptions: ChatCompletionOptions = {
      temperature: this.configManager.get('chatTemperature'),
      topK: topK > 0 ? topK : undefined,
      topP: this.configManager.get('chatTopP'),
      presencePenalty: this.configManager.get('chatPresencePenalty'),
      cachePrompt: true,
    };

    const mergedOptions = { ...defaultOptions, ...options };

    return llamaServerChatCompletionStream(
      this.serverUrl,
      messages,
      tools,
      mergedOptions,
      onDelta,
      undefined,
      signal
    );
  }

  /**
   * Count tokens in a text using the chat model's tokenizer
   * @param text Text to tokenize
   * @returns Promise that resolves to the token count
   */
  async countTokens(text: string): Promise<number> {
    if (this._status !== 'ready' || !this.port) {
      throw new Error('Chat server not initialized. Call initialize() first.');
    }

    const tokens = await llamaServerTokenize(this.serverUrl, text);
    return tokens.length;
  }

  async cleanup(): Promise<void> {
    this.log(`Cleaning up...`);

    if (this.exitHandlerBound) {
      process.off('exit', this.exitHandlerBound);
      process.off('SIGINT', this.exitHandlerBound);
      process.off('SIGTERM', this.exitHandlerBound);
      this.exitHandlerBound = null;
    }

    if (this.serverProcess) {
      this.log(`Stopping server on port ${this.port}`);
      await killServerProcess(this.serverProcess, this.configManager.logger);
      this.serverProcess = null;
    }

    this.port = null;
    this.setStatus('uninitialized');

    this.log(`Completed cleanup`);
  }
}
