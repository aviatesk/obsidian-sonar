import type { ConfigManager } from './ConfigManager';

/**
 * Base class providing logging functionality through ConfigManager
 * Automatically formats log messages with component name prefix
 */
export abstract class WithLogging {
  protected abstract configManager: ConfigManager;
  protected abstract readonly componentName: string;

  protected log(msg: string): void {
    this.configManager.getLogger().log(`[Sonar.${this.componentName}] ${msg}`);
  }

  protected error(msg: string): void {
    this.configManager
      .getLogger()
      .error(`[Sonar.${this.componentName}] ${msg}`);
  }

  protected warn(msg: string): void {
    this.configManager.getLogger().warn(`[Sonar.${this.componentName}] ${msg}`);
  }
}
