import type { GrayMatterFile } from "gray-matter";

/**
 * Type definitions for memory files, settings, and git operations.
 */

export type MemoryScope = "system" | "project" | "long-term" | "reference" | "archive";
export type MemoryLoadPolicy = "always" | "project" | "index" | "search-only";
export type MemoryStatus = "active" | "stale" | "archived";

export interface MemoryFrontmatter {
  description: string;
  limit?: number;
  tags?: string[];
  /** Memory tier/scope. Defaults from the top-level directory when omitted. */
  scope?: MemoryScope;
  /** How this file should be included in agent context. Defaults from scope. */
  load?: MemoryLoadPolicy;
  /** Optional project key for project-scoped memories. */
  project?: string;
  status?: MemoryStatus;
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
  autoSync?: {
    onSessionStart?: boolean;
  };
  injection?: "system-prompt" | "message-append";
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
