import { EventEmitter } from 'events';
import { ObsidianConfig } from './core/config';

export interface ObsidianSonarSettings extends ObsidianConfig {
  autoOpenRelatedNotes: boolean;
  autoIndex: boolean;
  indexDebounceMs: number;
  showIndexNotifications: boolean;
  statusBarMaxLength: number;
}

export type ConfigChangeListener = (
  key: keyof ObsidianSonarSettings,
  value: any,
  oldValue: any
) => void;

export type ConfigBatchChangeListener = (
  changes: Partial<ObsidianSonarSettings>
) => void;

export class ConfigManager extends EventEmitter {
  private settings: ObsidianSonarSettings;
  private saveCallback: (settings: ObsidianSonarSettings) => Promise<void>;
  private changeListeners: Map<string, Set<ConfigChangeListener>> = new Map();
  private batchChangeListeners: Set<ConfigBatchChangeListener> = new Set();

  private constructor(
    initialSettings: ObsidianSonarSettings,
    saveCallback: (settings: ObsidianSonarSettings) => Promise<void>
  ) {
    super();
    this.settings = { ...initialSettings };
    this.saveCallback = saveCallback;
  }

  /**
   * Static factory method to create ConfigManager instance
   */
  static async initialize(
    loadData: () => Promise<any>,
    saveData: (data: any) => Promise<void>,
    defaultSettings: ObsidianSonarSettings
  ): Promise<ConfigManager> {
    const loadedData = await loadData();
    const settings = Object.assign({}, defaultSettings, loadedData);
    return new ConfigManager(settings, saveData);
  }

  /**
   * Get the current value of a setting
   */
  get<K extends keyof ObsidianSonarSettings>(key: K): ObsidianSonarSettings[K] {
    return this.settings[key];
  }

  /**
   * Get all settings
   */
  getAll(): Readonly<ObsidianSonarSettings> {
    return { ...this.settings };
  }

  /**
   * Update a single setting
   */
  async set<K extends keyof ObsidianSonarSettings>(
    key: K,
    value: ObsidianSonarSettings[K]
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
  async update(changes: Partial<ObsidianSonarSettings>): Promise<void> {
    const oldValues: Partial<ObsidianSonarSettings> = {};
    let hasChanges = false;

    // Check for actual changes
    for (const [key, value] of Object.entries(changes)) {
      const k = key as keyof ObsidianSonarSettings;
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
      const k = key as keyof ObsidianSonarSettings;
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
  subscribe<K extends keyof ObsidianSonarSettings>(
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

  /**
   * Subscribe to all setting changes
   */
  subscribeToAll(listener: ConfigBatchChangeListener): () => void {
    this.batchChangeListeners.add(listener);

    // Return unsubscribe function
    return () => {
      this.batchChangeListeners.delete(listener);
    };
  }

  /**
   * Check if a path should be excluded based on current settings
   */
  isPathExcluded(path: string): boolean {
    const excludedPaths = this.settings.excludedPaths || [];
    const indexPath = this.settings.indexPath.startsWith('/')
      ? this.settings.indexPath.slice(1)
      : this.settings.indexPath;

    // Check if path is within index path
    if (indexPath && indexPath !== '') {
      if (!path.startsWith(indexPath)) {
        return true; // Outside index path
      }
    }

    // Check excluded paths
    for (const pattern of excludedPaths) {
      const cleanPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern;

      // Simple pattern matching (can be extended with glob support)
      if (path.includes(cleanPattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the normalized index path
   */
  getNormalizedIndexPath(): string {
    let path = this.settings.indexPath;
    if (!path.startsWith('/')) {
      path = '/' + path;
    }
    // Remove trailing slash unless it's root
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return path;
  }

  /**
   * Reload settings from external source
   */
  reload(newSettings: ObsidianSonarSettings): void {
    const oldSettings = { ...this.settings };
    this.settings = { ...newSettings };

    // Find all changes
    const changes: Partial<ObsidianSonarSettings> = {};
    for (const key in newSettings) {
      const k = key as keyof ObsidianSonarSettings;
      if (oldSettings[k] !== newSettings[k]) {
        (changes as any)[k] = newSettings[k];
        this.notifyListeners(k, newSettings[k], oldSettings[k]);
      }
    }

    if (Object.keys(changes).length > 0) {
      this.notifyBatchListeners(changes);
      this.emit('reload', changes);
    }
  }

  private notifyListeners<K extends keyof ObsidianSonarSettings>(
    key: K,
    value: ObsidianSonarSettings[K],
    oldValue: ObsidianSonarSettings[K]
  ): void {
    const listeners = this.changeListeners.get(String(key));
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(key, value, oldValue);
        } catch (error) {
          console.error(`Error in config listener for ${String(key)}:`, error);
        }
      });
    }
  }

  private notifyBatchListeners(changes: Partial<ObsidianSonarSettings>): void {
    this.batchChangeListeners.forEach(listener => {
      try {
        listener(changes);
      } catch (error) {
        console.error('Error in batch config listener:', error);
      }
    });
  }
}
