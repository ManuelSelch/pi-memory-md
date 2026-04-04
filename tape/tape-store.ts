import fs from "node:fs";
import path from "node:path";
import type { TapeEntry, TapeEntryKind } from "./tape-types.js";
import { getLocalPath } from "../memory-md.js";

export class MemoryTapeStore {
  private tapePath: string;

  constructor(
    memoryDir: string,
    customTapePath?: string,
    projectName?: string,
    sessionId?: string,
  ) {
    const tapeDir = customTapePath || path.join(getLocalPath(), "TAPE");
    fs.mkdirSync(tapeDir, { recursive: true });

    const name = projectName || path.basename(memoryDir);
    const sid = sessionId || process.env.PI_SESSION_ID || "unknown";
    this.tapePath = path.join(tapeDir, `${name}__${sid}.jsonl`);
  }



  append(entry: TapeEntry): void {
    fs.appendFileSync(this.tapePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  query(options: {
    query?: string;
    kinds?: TapeEntryKind[];
    limit?: number;
    since?: string;
    sinceAnchor?: string;
    lastAnchor?: boolean;
    betweenAnchors?: { start: string; end: string };
    betweenDates?: { start: string; end: string };
  }): TapeEntry[] {
    if (!fs.existsSync(this.tapePath)) {
      return [];
    }

    const content = fs.readFileSync(this.tapePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    let entries = lines.map((line) => this.parseEntry(line)).filter(Boolean) as TapeEntry[];
    const { sinceAnchor, lastAnchor, betweenAnchors, betweenDates, query, kinds, limit } = options;
    const sinceTime = options.since ? new Date(options.since).getTime() : 0;

    if (betweenAnchors) {
      const startIdx = this.findAnchorIndex(entries, betweenAnchors.start);
      const endIdx = this.findAnchorIndex(entries, betweenAnchors.end, startIdx + 1);
      if (startIdx >= 0 && endIdx >= 0) {
        entries = entries.slice(startIdx + 1, endIdx);
      } else {
        return [];
      }
    } else if (lastAnchor) {
      const lastAnchorIdx = this.findLastAnchorIndex(entries);
      if (lastAnchorIdx >= 0) {
        entries = entries.slice(lastAnchorIdx + 1);
      } else {
        return [];
      }
    } else if (sinceAnchor) {
      const anchorIdx = this.findAnchorIndex(entries, sinceAnchor);
      if (anchorIdx >= 0) {
        entries = entries.slice(anchorIdx + 1);
      } else {
        return [];
      }
    }

    if (betweenDates) {
      const startTime = new Date(betweenDates.start).getTime();
      const endTime = new Date(betweenDates.end).getTime();
      entries = entries.filter((entry) => {
        const entryTime = new Date(entry.timestamp).getTime();
        return entryTime >= startTime && entryTime <= endTime;
      });
    }

    if (query) {
      const needle = query.toLowerCase();
      entries = entries.filter((entry) => {
        const haystack = JSON.stringify({
          kind: entry.kind,
          date: entry.timestamp,
          payload: entry.payload,
          meta: entry,
        }).toLowerCase();
        return haystack.includes(needle);
      });
    }

    if (kinds) {
      entries = entries.filter((entry) => kinds.includes(entry.kind));
    }

    if (sinceTime > 0) {
      entries = entries.filter((entry) => new Date(entry.timestamp).getTime() >= sinceTime);
    }

    if (limit) {
      entries = entries.slice(0, limit);
    }

    return entries;
  }

  private findAnchorIndex(entries: TapeEntry[], name: string, start: number = 0): number {
    for (let i = start; i < entries.length; i++) {
      if (entries[i].kind === "anchor" || entries[i].kind === "session/start") {
        if ((entries[i].payload.name as string) === name) {
          return i;
        }
      }
    }
    return -1;
  }

  private findLastAnchorIndex(entries: TapeEntry[]): number {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].kind === "anchor" || entries[i].kind === "session/start") {
        return i;
      }
    }
    return -1;
  }

  private parseEntry(line: string): TapeEntry | null {
    try {
      return JSON.parse(line) as TapeEntry;
    } catch {
      return null;
    }
  }

  getLastAnchor(): TapeEntry | null {
    const entries = this.query({ kinds: ["session/start", "anchor"], limit: 1 });
    if (entries.length === 0) return null;
    return entries[entries.length - 1];
  }

  findAnchorByName(name: string): TapeEntry | null {
    const entries = this.query({ kinds: ["anchor", "session/start"] });
    return entries.find((e) => (e.payload.name as string) === name) || null;
  }

  clear(): void {
    if (fs.existsSync(this.tapePath)) {
      fs.unlinkSync(this.tapePath);
    }
  }
}
