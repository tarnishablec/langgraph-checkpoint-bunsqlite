/**
 * BunSqliteSaver - LangGraph checkpoint persistence using Bun's native bun:sqlite
 * 
 * This module provides a checkpoint saver implementation for LangGraph that uses
 * Bun's native SQLite database for persistent storage.
 * 
 * @warning This package ONLY works with Bun runtime. It will not work with Node.js or other runtimes.
 */

// Runtime check - ensure we're running on Bun
if (typeof Bun === "undefined") {
  throw new Error(
    "langgraph-checkpoint-bunsqlite requires Bun runtime. " +
    "This package uses bun:sqlite which is not available in Node.js or other runtimes. " +
    "Please use Bun to run this code, or use @langchain/langgraph-checkpoint-sqlite for Node.js."
  );
}

import { Database } from "bun:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import { SerializerProtocol } from "@langchain/langgraph-checkpoint";
import type {
  CheckpointMetadata,
  CheckpointPendingWrite,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";

/**
 * Configuration options for BunSqliteSaver
 */
export interface BunSqliteSaverConfig {
  /**
   * Path to the SQLite database file.
   * Use ":memory:" for an in-memory database (default).
   */
  dbPath?: string;
  
  /**
   * Custom serializer for checkpoint data.
   * If not provided, uses the default serializer from BaseCheckpointSaver.
   */
  serializer?: SerializerProtocol;
}

/**
 * Statistics about the checkpoint storage
 */
export interface CheckpointStats {
  /**
   * Total number of checkpoints stored
   */
  totalCheckpoints: number;
  
  /**
   * Total number of pending writes stored
   */
  totalWrites: number;
  
  /**
   * Number of unique threads
   */
  totalThreads: number;
}

/**
 * Internal row structure for checkpoints table
 */
interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
}

/**
 * Internal row structure for checkpoint_writes table
 */
interface CheckpointWriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: Uint8Array;
}

/**
 * BunSqliteSaver - Persistent checkpoint storage using Bun's native SQLite
 * 
 * This class implements the BaseCheckpointSaver interface to provide persistent
 * storage for LangGraph checkpoints using Bun's built-in SQLite database.
 * 
 * Features:
 * - Persistent storage of checkpoints and pending writes
 * - Support for checkpoint history and versioning
 * - Thread-based isolation of checkpoint data
 * - Efficient querying with indexes
 * 
 * @example
 * ```typescript
 * import { BunSqliteSaver } from "langgraph-checkpoint-bunsqlite";
 * 
 * // Create an in-memory checkpoint saver
 * const saver = new BunSqliteSaver({ dbPath: ":memory:" });
 * 
 * // Or use a file-based database
 * const fileSaver = new BunSqliteSaver({ dbPath: "./checkpoints.db" });
 * ```
 */
export class BunSqliteSaver extends BaseCheckpointSaver {
  private db: Database;
  private isOwned: boolean;

  /**
   * Create a new BunSqliteSaver instance
   * 
   * @param config - Configuration options
   */
  constructor(config: BunSqliteSaverConfig = {}) {
    super(config.serializer);
    
    const dbPath = config.dbPath ?? ":memory:";
    this.db = new Database(dbPath, { create: true });
    this.isOwned = true;
    
    this.setupTables();
  }

  /**
   * Create a BunSqliteSaver from an existing Database instance
   * 
   * This allows you to reuse an existing SQLite database connection.
   * The saver will NOT close the database when close() is called.
   * 
   * @param db - Existing Database instance
   * @param serde - Optional custom serializer
   * @returns New BunSqliteSaver instance
   * 
   * @example
   * ```typescript
   * import { Database } from "bun:sqlite";
   * import { BunSqliteSaver } from "langgraph-checkpoint-bunsqlite";
   * 
   * const db = new Database("./my-app.db");
   * const saver = BunSqliteSaver.fromDatabase(db);
   * ```
   */
  static fromDatabase(
    db: Database,
    serde?: SerializerProtocol
  ): BunSqliteSaver {
    const instance = new BunSqliteSaver({ dbPath: ":memory:", serializer: serde });
    // Replace the database with the provided one
    if (instance.isOwned) {
      instance.db.close();
    }
    instance.db = db;
    instance.isOwned = false;
    instance.setupTables();
    return instance;
  }

  /**
   * Initialize database tables and indexes
   */
  private setupTables(): void {
    // Create checkpoints table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `);

    // Create indexes for efficient querying
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_id 
      ON checkpoints(thread_id)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_parent 
      ON checkpoints(thread_id, checkpoint_ns, parent_checkpoint_id)
    `);

    // Create checkpoint_writes table for pending writes
    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoint_writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `);

    // Create index for efficient write queries
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoint_writes 
      ON checkpoint_writes(thread_id, checkpoint_ns, checkpoint_id)
    `);
  }

  /**
   * Get a checkpoint tuple by its configuration
   * 
   * @param config - Runnable configuration containing thread_id and checkpoint_id
   * @returns The checkpoint tuple or undefined if not found
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;

    if (threadId === undefined) {
      return undefined;
    }

    let row: CheckpointRow | null;

    if (checkpointId !== undefined) {
      // Get specific checkpoint
      const stmt = this.db.query<CheckpointRow, [string, string, string]>(`
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, 
               type, checkpoint, metadata
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `);
      row = stmt.get(threadId, checkpointNs, checkpointId);
    } else {
      // Get latest checkpoint
      const stmt = this.db.query<CheckpointRow, [string, string]>(`
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
               type, checkpoint, metadata
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ?
        ORDER BY checkpoint_id DESC
        LIMIT 1
      `);
      row = stmt.get(threadId, checkpointNs);
    }

    if (row === null) {
      return undefined;
    }

    // Deserialize checkpoint and metadata
    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint
    )) as Checkpoint;
    
    const metadata = (await this.serde.loadsTyped(
      "json",
      row.metadata
    )) as CheckpointMetadata;

    // Get pending writes for this checkpoint
    const writesStmt = this.db.query<CheckpointWriteRow, [string, string, string]>(`
      SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value
      FROM checkpoint_writes
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      ORDER BY task_id, idx
    `);
    
    const writeRows = writesStmt.all(row.thread_id, row.checkpoint_ns, row.checkpoint_id);
    
    const pendingWrites: CheckpointPendingWrite[] = [];
    for (const writeRow of writeRows) {
      const value = await this.serde.loadsTyped(
        writeRow.type ?? "json",
        writeRow.value
      );
      pendingWrites.push([writeRow.task_id, writeRow.channel, value]);
    }

    // Build config for this checkpoint
    const checkpointConfig: RunnableConfig = {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.checkpoint_id,
      },
    };

    // Build parent config if exists
    let parentConfig: RunnableConfig | undefined;
    if (row.parent_checkpoint_id !== null) {
      parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      };
    }

    return {
      config: checkpointConfig,
      checkpoint,
      metadata,
      parentConfig,
      pendingWrites: pendingWrites.length > 0 ? pendingWrites : undefined,
    };
  }

  /**
   * List checkpoints matching the given criteria
   * 
   * @param config - Base configuration containing thread_id
   * @param options - Filter and pagination options
   * @yields Checkpoint tuples in reverse chronological order
   */
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";

    if (threadId === undefined) {
      return;
    }

    let sql = `
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
             type, checkpoint, metadata
      FROM checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
    `;
    const params: (string | number)[] = [threadId, checkpointNs];

    // Add before filter if specified
    if (options?.before?.configurable?.checkpoint_id !== undefined) {
      sql += ` AND checkpoint_id < ?`;
      params.push(options.before.configurable.checkpoint_id);
    }

    // Order by checkpoint_id descending (newest first)
    sql += ` ORDER BY checkpoint_id DESC`;

    // Add limit if specified
    if (options?.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const stmt = this.db.query<CheckpointRow, (string | number)[]>(sql);
    const rows = stmt.all(...params);

    for (const row of rows) {
      // Deserialize checkpoint and metadata
      const checkpoint = (await this.serde.loadsTyped(
        row.type ?? "json",
        row.checkpoint
      )) as Checkpoint;
      
      const metadata = (await this.serde.loadsTyped(
        "json",
        row.metadata
      )) as CheckpointMetadata;

      // Check filter if specified
      if (options?.filter !== undefined) {
        const metadataRecord = metadata as unknown as Record<string, unknown>;
        const matches = Object.entries(options.filter).every(
          ([key, value]) => metadataRecord[key] === value
        );
        if (!matches) {
          continue;
        }
      }

      // Get pending writes
      const writesStmt = this.db.query<CheckpointWriteRow, [string, string, string]>(`
        SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value
        FROM checkpoint_writes
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
        ORDER BY task_id, idx
      `);
      
      const writeRows = writesStmt.all(row.thread_id, row.checkpoint_ns, row.checkpoint_id);
      
      const pendingWrites: CheckpointPendingWrite[] = [];
      for (const writeRow of writeRows) {
        const value = await this.serde.loadsTyped(
          writeRow.type ?? "json",
          writeRow.value
        );
        pendingWrites.push([writeRow.task_id, writeRow.channel, value]);
      }

      // Build config for this checkpoint
      const checkpointConfig: RunnableConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      };

      // Build parent config if exists
      let parentConfig: RunnableConfig | undefined;
      if (row.parent_checkpoint_id !== null) {
        parentConfig = {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.parent_checkpoint_id,
          },
        };
      }

      yield {
        config: checkpointConfig,
        checkpoint,
        metadata,
        parentConfig,
        pendingWrites: pendingWrites.length > 0 ? pendingWrites : undefined,
      };
    }
  }

  /**
   * Save a checkpoint to the database
   * 
   * @param config - Configuration containing thread_id and checkpoint_ns
   * @param checkpoint - The checkpoint to save
   * @param metadata - Metadata associated with the checkpoint
   * @returns Updated configuration with the checkpoint_id
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const parentCheckpointId = config.configurable?.checkpoint_id;

    if (threadId === undefined) {
      throw new Error("thread_id is required in config.configurable");
    }

    // Serialize checkpoint and metadata
    const [checkpointType, checkpointData] = await this.serde.dumpsTyped(checkpoint);
    const [, metadataData] = await this.serde.dumpsTyped(metadata);

    // Use checkpoint's ID
    const checkpointId = checkpoint.id;

    // Insert or replace checkpoint
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO checkpoints 
      (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      threadId,
      checkpointNs,
      checkpointId,
      parentCheckpointId ?? null,
      checkpointType,
      checkpointData,
      metadataData
    );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
      },
    };
  }

  /**
   * Save pending writes associated with a checkpoint
   * 
   * @param config - Configuration containing thread_id, checkpoint_ns, and checkpoint_id
   * @param writes - Array of pending writes to save
   * @param taskId - ID of the task that produced these writes
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;

    if (threadId === undefined) {
      throw new Error("thread_id is required in config.configurable");
    }

    if (checkpointId === undefined) {
      throw new Error("checkpoint_id is required in config.configurable");
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO checkpoint_writes
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let idx = 0; idx < writes.length; idx++) {
      const [channel, value] = writes[idx];
      const [type, serializedValue] = await this.serde.dumpsTyped(value);

      stmt.run(
        threadId,
        checkpointNs,
        checkpointId,
        taskId,
        idx,
        channel,
        type,
        serializedValue
      );
    }
  }

  /**
   * Delete all checkpoints and writes for a specific thread
   * 
   * @param threadId - ID of the thread to delete
   */
  async deleteThread(threadId: string): Promise<void> {
    // Delete writes first
    const deleteWritesStmt = this.db.prepare(`
      DELETE FROM checkpoint_writes WHERE thread_id = ?
    `);
    deleteWritesStmt.run(threadId);

    // Delete checkpoints
    const deleteCheckpointsStmt = this.db.prepare(`
      DELETE FROM checkpoints WHERE thread_id = ?
    `);
    deleteCheckpointsStmt.run(threadId);
  }

  /**
   * Delete a specific checkpoint and its associated writes
   * 
   * @param threadId - ID of the thread
   * @param checkpointId - ID of the checkpoint to delete
   * @param checkpointNs - Namespace of the checkpoint (default: "")
   * @returns True if the checkpoint was deleted, false if not found
   */
  deleteCheckpoint(
    threadId: string,
    checkpointId: string,
    checkpointNs: string = ""
  ): boolean {
    // Delete writes first
    const deleteWritesStmt = this.db.prepare(`
      DELETE FROM checkpoint_writes 
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
    `);
    deleteWritesStmt.run(threadId, checkpointNs, checkpointId);

    // Delete checkpoint
    const deleteCheckpointStmt = this.db.prepare(`
      DELETE FROM checkpoints 
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
    `);
    const result = deleteCheckpointStmt.run(threadId, checkpointNs, checkpointId);

    return result.changes > 0;
  }

  /**
   * Get statistics about the checkpoint storage
   * 
   * @returns Statistics about stored checkpoints and writes
   */
  getStats(): CheckpointStats {
    const checkpointsStmt = this.db.query<{ count: number }, []>(`
      SELECT COUNT(*) as count FROM checkpoints
    `);
    const totalCheckpoints = checkpointsStmt.get()?.count ?? 0;

    const writesStmt = this.db.query<{ count: number }, []>(`
      SELECT COUNT(*) as count FROM checkpoint_writes
    `);
    const totalWrites = writesStmt.get()?.count ?? 0;

    const threadsStmt = this.db.query<{ count: number }, []>(`
      SELECT COUNT(DISTINCT thread_id) as count FROM checkpoints
    `);
    const totalThreads = threadsStmt.get()?.count ?? 0;

    return {
      totalCheckpoints,
      totalWrites,
      totalThreads,
    };
  }

  /**
   * Close the database connection
   * 
   * This should be called when you're done using the saver to ensure
   * all data is flushed and the database is properly closed.
   * 
   * Note: If this instance was created with fromDatabase(), the database
   * will NOT be closed (since it's externally owned).
   */
  close(): void {
    if (this.isOwned && this.db) {
      this.db.close();
    }
  }
}

// Export all types from the checkpoint library for convenience
export type {
  Checkpoint,
  CheckpointTuple,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";

export { SerializerProtocol } from "@langchain/langgraph-checkpoint";
