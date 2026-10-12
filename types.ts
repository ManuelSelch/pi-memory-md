import type { GrayMatterFile } from "gray-matter";

/**
 * Type definitions for memory files, settings, and git operations.
 */

export interface MemoryFrontmatter {
  description: string;
  limit?: number;
  tags?: string[];
  created?: string;
  updated?: string;
  generated?: boolean;
  generator?: string;
}

export interface MemoryFile {
  path: string;
  frontmatter: MemoryFrontmatter;
  content: string;
}

export interface MemoryMdSettings {
  enabled?: boolean;
  repoUrl?: string;
  localPath?: string;
  /** Absolute or home-relative external Markdown roots to include as read-only references. */
  referencePaths?: string[];
  systemPrompt?: {
    maxTokens?: number;
    includeProjects?: string[];
  };
}

export interface GitResult {
  stdout: string;
  success: boolean;
  timeout?: boolean;
}

export interface SyncResult {
  success: boolean;
  message: string;
  updated?: boolean;
}

export type ParsedFrontmatter = GrayMatterFile<string>["data"];
