import { EventEmitter } from 'events';
import type { App } from 'obsidian';
import type { SonarSettings } from './config';
import { Logger } from './Logger';
import { confirmAction } from './Utils';

export type ConfigChangeListener = (
  key: keyof SonarSettings,
  value: any,
  oldValue: any
) => void;

export type ConfigBatchChangeListener = (
  changes: Partial<SonarSettings>
) => void;

export class ConfigManager extends EventEmitter {
  private settings: SonarSettings;
  private saveCallback: (settings: SonarSettings) => Promise<void>;
  private changeListeners: Map<string, Set<ConfigChangeListener>> = new Map();
  private batchChangeListeners: Set<ConfigBatchChangeListener> = new Set();
  logger: Logger;

  private constructor(
    initialSettings: SonarSettings,
    saveCallback: (settings: SonarSettings) => Promise<void>
  ) {
    super();
    this.settings = { ...initialSettings };
    this.saveCallback = saveCallback;
    this.logger = new Logger(() => this.settings.debugMode);
  }

  /**
   * Static factory method to create ConfigManager instance
   */
  static async initialize(
    loadData: () => Promise<any>,
    saveData: (data: any) => Promise<void>,
    defaultSettings: SonarSettings
  ): Promise<ConfigManager> {
    const loadedData = await loadData();
    const settings = Object.assign({}, defaultSettings, loadedData);
    return new ConfigManager(settings, saveData);
  }

  /**
   * Get the current value of a setting
   */
  get<K extends keyof SonarSettings>(key: K): SonarSettings[K] {
    return this.settings[key];
  }

  getLogger(): Logger {
    return this.logger;
  }

  /**
   * Get formatted string of current embedder configuration
   */
  getCurrentConfigInfo(): string {
    const embedderBackend = this.get('embedderBackend');
    const embeddingModel = this.get('embeddingModel');
    return `- Embedding backend: \`${embedderBackend}\`\n- Embedding model: \`${embeddingModel}\``;
  }

  /**
   * Show confirmation dialog for clearing current index
   */
  async confirmClearCurrentIndex(app: App): Promise<boolean> {
    return confirmAction(
      app,
      'Clear current index',
      `Clear current search index?\n\n${this.getCurrentConfigInfo()}\n\nThis will clear the index for the current configuration. This cannot be undone.`,
      'Clear'
    );
  }

  /**
   * Show confirmation dialog for rebuilding index
   */
  async confirmRebuildIndex(app: App): Promise<boolean> {
    return confirmAction(
      app,
      'Rebuild index',
      `Rebuild entire search index?\n\n${this.getCurrentConfigInfo()}\n\nThis will clear and rebuild the index for the current configuration. This cannot be undone.`,
      'Rebuild'
    );
  }

  /**
   * Show confirmation dialog for deleting all vault databases
   */
  async confirmDeleteAllVaultDatabases(
    app: App,
    vaultName: string,
    databases: string[]
  ): Promise<boolean> {
    const message = `Delete all search databases for this vault?\n\nFound ${databases.length} database(s) for vault "${vaultName}":\n\n${databases.map(db => `  - \`${db}\``).join('\n')}\n\nThis will delete all databases for this vault. This cannot be undone.`;
    return confirmAction(
      app,
      'Delete all vault databases',
      message,
      'Delete All'
    );
  }

  /**
   * Update a single setting
   */
  async set<K extends keyof SonarSettings>(
    key: K,
    value: SonarSettings[K]
  ): Promise<void> {
    const oldValue = this.settings[key];

    if (oldValue === value) {
      return; // No change
    }

    this.settings[key] = value;

    // Notify specific key listeners
    this.notifyListeners(key, value, oldValue);

    // Notify batch listeners with single change
    this.notifyBatchListeners({ [key]: value });

    // Save settings
    await this.saveCallback(this.settings);

    // Emit event for backward compatibility
    this.emit('change', key, value, oldValue);
    this.emit(`change:${String(key)}`, value, oldValue);
  }

  /**
   * Update multiple settings at once
   */
  async update(changes: Partial<SonarSettings>): Promise<void> {
    const oldValues: Partial<SonarSettings> = {};
    let hasChanges = false;

    // Check for actual changes
    for (const [key, value] of Object.entries(changes)) {
      const k = key as keyof SonarSettings;
      if (this.settings[k] !== value) {
        (oldValues as any)[k] = this.settings[k];
        (this.settings as any)[k] = value;
        hasChanges = true;
      }
    }

    if (!hasChanges) {
      return; // No actual changes
    }

    // Notify individual listeners for each changed key
    for (const [key, value] of Object.entries(changes)) {
      const k = key as keyof SonarSettings;
      if (oldValues[k] !== undefined) {
        this.notifyListeners(k, value, oldValues[k]);
      }
    }

    // Notify batch listeners
    this.notifyBatchListeners(changes);

    // Save settings
    await this.saveCallback(this.settings);

    // Emit batch change event
    this.emit('batchChange', changes, oldValues);
  }

  /**
   * Subscribe to changes for a specific setting key
   */
  subscribe<K extends keyof SonarSettings>(
    key: K,
    listener: ConfigChangeListener
  ): () => void {
    const keyStr = String(key);
    if (!this.changeListeners.has(keyStr)) {
      this.changeListeners.set(keyStr, new Set());
    }
    this.changeListeners.get(keyStr)!.add(listener);

    // Return unsubscribe function
    return () => {
      const listeners = this.changeListeners.get(keyStr);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.changeListeners.delete(keyStr);
        }
      }
    };
  }

  private notifyListeners<K extends keyof SonarSettings>(
    key: K,
    value: SonarSettings[K],
    oldValue: SonarSettings[K]
  ): void {
    const listeners = this.changeListeners.get(String(key));
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(key, value, oldValue);
        } catch (err) {
          this.logger.error(
            `Error in config listener for ${String(key)}: ${err}`
          );
        }
      });
    }
  }

  private notifyBatchListeners(changes: Partial<SonarSettings>): void {
    this.batchChangeListeners.forEach(listener => {
      try {
        listener(changes);
      } catch (err) {
        this.logger.error(`Error in batch config listener: ${err}`);
      }
    });
  }
}
