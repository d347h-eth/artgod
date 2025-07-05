import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Resolves the project root path from any file within the shared module
 * @returns The absolute path to the project root directory
 */
export function getProjectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Go up two levels from shared/utils to reach project root
  return resolve(__dirname, '../../');
}

/**
 * Resolves a path relative to the project root
 * @param relativePath - Path relative to project root (e.g., 'database/migrations')
 * @returns The absolute path
 */
export function resolveProjectPath(relativePath: string): string {
  return resolve(getProjectRoot(), relativePath);
}
