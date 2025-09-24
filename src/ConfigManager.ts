import { EventEmitter } from 'events';
import type { ObsidianSettings } from './config';
import { Logger } from './Logger';

export type { ObsidianSettings };

export type ConfigChangeListener = (
  key: keyof ObsidianSettings,
  value: any,
  oldValue: any
) => void;

export type ConfigBatchChangeListener = (
  changes: Partial<ObsidianSettings>
) => void;

export class ConfigManager extends EventEmitter {
  private settings: ObsidianSettings;
  private saveCallback: (settings: ObsidianSettings) => Promise<void>;
  private changeListeners: Map<string, Set<ConfigChangeListener>> = new Map();
  private batchChangeListeners: Set<ConfigBatchChangeListener> = new Set();
  private logger: Logger;

  private constructor(
    initialSettings: ObsidianSettings,
    saveCallback: (settings: ObsidianSettings) => Promise<void>
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
    defaultSettings: ObsidianSettings
  ): Promise<ConfigManager> {
    const loadedData = await loadData();
    const settings = Object.assign({}, defaultSettings, loadedData);
    return new ConfigManager(settings, saveData);
  }

  /**
   * Get the current value of a setting
   */
  get<K extends keyof ObsidianSettings>(key: K): ObsidianSettings[K] {
    return this.settings[key];
  }

  getLogger(): Logger {
    return this.logger;
  }

  /**
   * Update a single setting
   */
  async set<K extends keyof ObsidianSettings>(
    key: K,
    value: ObsidianSettings[K]
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
  async update(changes: Partial<ObsidianSettings>): Promise<void> {
    const oldValues: Partial<ObsidianSettings> = {};
    let hasChanges = false;

    // Check for actual changes
    for (const [key, value] of Object.entries(changes)) {
      const k = key as keyof ObsidianSettings;
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
      const k = key as keyof ObsidianSettings;
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
  subscribe<K extends keyof ObsidianSettings>(
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

  private notifyListeners<K extends keyof ObsidianSettings>(
    key: K,
    value: ObsidianSettings[K],
    oldValue: ObsidianSettings[K]
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

  private notifyBatchListeners(changes: Partial<ObsidianSettings>): void {
    this.batchChangeListeners.forEach(listener => {
      try {
        listener(changes);
      } catch (err) {
        this.logger.error(`Error in batch config listener: ${err}`);
      }
    });
  }
}
