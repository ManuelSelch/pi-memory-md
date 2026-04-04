/**
 * Tape layer for pi-memory-md
 * Records memory operations and provides dynamic context injection
 */

export type TapeEntryKind =
  // Memory operations
  | "memory/read"
  | "memory/write"
  | "memory/search"
  | "memory/sync"
  | "memory/init"
  // Conversation events
  | "message/user"
  | "message/assistant"
  | "tool_call"
  | "tool_result"
  // Checkpoints
  | "session/start"
  | "anchor";

export type TapeContextStrategy = "recent-only" | "smart";

export interface TapeEntry {
  id: string;
  kind: TapeEntryKind;
  timestamp: string;
  turn?: number; // Track conversation turn
  payload: Record<string, unknown>;
  hash?: string; // Content hash for duplicate detection
}

export interface TapeQueryOptions {
  query?: string; // Text search in entry payload
  kinds?: TapeEntryKind[];
  limit?: number;
  since?: string; // ISO timestamp
  sinceAnchor?: string; // anchor ID
  lastAnchor?: boolean; // Get entries after the last anchor
  betweenAnchors?: { start: string; end: string }; // Get entries between two anchors (by name)
  betweenDates?: { start: string; end: string }; // Get entries between two dates (ISO format)
}

export type ContextStrategy = "recent-only" | "smart";

export interface ContextSelection {
  files: string[];
  reason: string;
}

export interface TapeConfig {
  contextStrategy: TapeContextStrategy;
  fileLimit: number;
  alwaysInclude?: string[];
  tapePath?: string;
  maxTapeTokens?: number; // Max tokens for tape context (default: 1000)
  maxTapeEntries?: number; // Max entries to consider before token limit (default: 10)
  enableDuplicateDetection?: boolean;
  maxConversationHistory?: number; // Maximum conversation entries to include (default: 5)
  includeConversationHistory?: boolean; // Whether to include conversation history (default: true)
  autoAnchor?: "never" | "turn" | "threshold"; // Auto-anchor strategy (default: "threshold")
  anchorThreshold?: number; // Entries since last anchor before auto-creating (default: 5)
}
