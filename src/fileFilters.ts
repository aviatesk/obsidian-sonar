import { TFile, normalizePath } from 'obsidian';
import { ConfigManager } from './ConfigManager';

/**
 * Utility functions for filtering files based on index path and excluded paths
 */

/**
 * Normalize index path using Obsidian's normalizePath
 * (which already removes leading/trailing slashes)
 */
export function normalizeIndexPath(path: string): string {
  return normalizePath(path);
}

/**
 * Check if a file path matches an exclusion pattern
 */
function matchesExclusionPattern(filePath: string, pattern: string): boolean {
  // normalizePath already removes leading slashes
  const cleanPattern = normalizePath(pattern);

  // Check if it's a glob pattern (contains *, ?, [, ])
  if (
    cleanPattern.includes('*') ||
    cleanPattern.includes('?') ||
    cleanPattern.includes('[') ||
    cleanPattern.includes(']')
  ) {
    // For now, do simple wildcard matching
    // Convert * to regex pattern
    const regexPattern = cleanPattern
      .replace(/[.+^${}()|\\]/g, '\\$&') // Escape special regex chars
      .replace(/\*/g, '.*') // Convert * to .*
      .replace(/\?/g, '.'); // Convert ? to .
    const regex = new RegExp('^' + regexPattern + '$');
    return regex.test(filePath);
  }

  // Check if it's a folder name or path
  if (!cleanPattern.includes('/')) {
    // Check if any folder in the path matches the pattern
    const pathParts = filePath.split('/');
    return pathParts.slice(0, -1).includes(cleanPattern);
  }

  // It's a relative path - check if file path starts with it
  return (
    filePath.startsWith(cleanPattern) || filePath.startsWith(cleanPattern + '/')
  );
}

/**
 * Check if a file should be indexed based on configuration
 */
export function shouldIndexFile(
  file: TFile,
  configManager: ConfigManager
): boolean {
  // Only index markdown files
  if (!file.extension || file.extension !== 'md') {
    return false;
  }

  const indexPath = configManager.get('indexPath');
  const normalizedIndexPath = normalizeIndexPath(indexPath);

  // Check if file is within index path
  if (normalizedIndexPath && normalizedIndexPath !== '') {
    if (!file.path.startsWith(normalizedIndexPath)) {
      return false;
    }
  }

  // Check excluded paths
  const excludedPaths = configManager.get('excludedPaths') || [];
  for (const pattern of excludedPaths) {
    if (matchesExclusionPattern(file.path, pattern)) {
      return false;
    }
  }

  return true;
}

/**
 * Get all markdown files that should be indexed
 */
export function getIndexableFiles(
  allFiles: TFile[],
  configManager: ConfigManager
): TFile[] {
  return allFiles.filter(file => shouldIndexFile(file, configManager));
}
