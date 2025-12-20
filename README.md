# langgraph-checkpoint-bunsqlite

> A LangGraph checkpoint saver implementation using Bun's native SQLite

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

## ⚠️ Important: Bun Only

**This package requires [Bun](https://bun.sh/) runtime and will NOT work with Node.js, Deno, or other JavaScript runtimes.**

It uses Bun's native `bun:sqlite` module which is not available in other runtimes. If you need SQLite checkpoint storage for Node.js, please use [@langchain/langgraph-checkpoint-sqlite](https://www.npmjs.com/package/@langchain/langgraph-checkpoint-sqlite) instead.

## Overview

`langgraph-checkpoint-bunsqlite` provides persistent checkpoint storage for [LangGraph.js](https://github.com/langchain-ai/langgraphjs) applications using Bun's native `bun:sqlite` module. This implementation offers:

- 🚀 **Native Performance** - Uses Bun's built-in SQLite for maximum speed
- 💾 **Persistent Storage** - Save checkpoints to disk or use in-memory database
- 🔒 **Type Safety** - Full TypeScript support with strict type checking
- 🧹 **Clean API** - Simple, intuitive interface matching LangGraph standards
- 📦 **Zero Config** - Works out of the box with sensible defaults

## Installation

**Prerequisites:** You must have [Bun](https://bun.sh/) installed. This package does not work with Node.js.

```bash
bun add langgraph-checkpoint-bunsqlite @langchain/langgraph-checkpoint
```

> **⚠️ Runtime Requirement:** This package ONLY works with Bun runtime. It uses `bun:sqlite` which is not available in Node.js, Deno, or other JavaScript runtimes. Attempting to use it with other runtimes will result in module resolution errors.

## Quick Start

### Basic Usage

```typescript
import { BunSqliteSaver } from "langgraph-checkpoint-bunsqlite";

// Create an in-memory checkpoint saver (great for development/testing)
const saver = new BunSqliteSaver();

// Or use a file-based database for persistence
const persistentSaver = new BunSqliteSaver({ 
  dbPath: "./my-checkpoints.db" 
});
```

### Using with LangGraph

```typescript
import { StateGraph } from "@langchain/langgraph";
import { BunSqliteSaver } from "langgraph-checkpoint-bunsqlite";

// Define your state type
interface AgentState {
  messages: string[];
  count: number;
}

// Create checkpoint saver
const checkpointer = new BunSqliteSaver({ 
  dbPath: "./agent-checkpoints.db" 
});

// Create a graph with checkpointing
const graph = new StateGraph<AgentState>({
  channels: {
    messages: {
      value: (prev: string[], next: string[]) => [...prev, ...next],
      default: () => [],
    },
    count: {
      value: (prev: number, next: number) => next,
      default: () => 0,
    },
  },
})
  .addNode("agent", async (state) => {
    return {
      messages: [`Step ${state.count}`],
      count: state.count + 1,
    };
  })
  .addEdge("__start__", "agent")
  .addEdge("agent", "__end__")
  .compile({ checkpointer });

// Run with checkpointing
const threadId = "thread-1";
const config = { configurable: { thread_id: threadId } };

// First run
await graph.invoke(
  { messages: [], count: 0 },
  config
);

// Resume from checkpoint
const result = await graph.invoke(
  { messages: [], count: 0 },
  config
);

// Clean up
checkpointer.close();
```

## Configuration

### BunSqliteSaverConfig

```typescript
interface BunSqliteSaverConfig {
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
```

### Examples

#### In-Memory Database (Default)

```typescript
const saver = new BunSqliteSaver();
// or explicitly
const saver = new BunSqliteSaver({ dbPath: ":memory:" });
```

#### File-Based Database

```typescript
const saver = new BunSqliteSaver({ 
  dbPath: "./checkpoints.db" 
});
```

#### Custom Serializer

```typescript
import { BunSqliteSaver } from "langgraph-checkpoint-bunsqlite";
import { JsonPlusSerializer } from "@langchain/langgraph-checkpoint";

const saver = new BunSqliteSaver({ 
  dbPath: "./checkpoints.db",
  serializer: new JsonPlusSerializer()
});
```

#### Using Existing Database Connection

```typescript
import { Database } from "bun:sqlite";
import { BunSqliteSaver } from "langgraph-checkpoint-bunsqlite";

const db = new Database("./my-app.db");
const saver = BunSqliteSaver.fromDatabase(db);

// The saver will use your existing database
// Note: calling saver.close() will NOT close the database
// since it's externally owned
```

## API Reference

### BunSqliteSaver

The main class implementing checkpoint persistence.

#### Constructor

```typescript
new BunSqliteSaver(config?: BunSqliteSaverConfig)
```

#### Static Methods

##### `fromDatabase(db: Database, serde?: SerializerProtocol): BunSqliteSaver`

Create a saver from an existing Database instance. The database will not be closed when `close()` is called.

#### Instance Methods

##### `getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined>`

Retrieve a specific checkpoint tuple.

```typescript
const tuple = await saver.getTuple({
  configurable: {
    thread_id: "thread-1",
    checkpoint_id: "checkpoint-123"
  }
});
```

##### `list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple>`

List checkpoints for a thread.

```typescript
const checkpoints = saver.list(
  { configurable: { thread_id: "thread-1" } },
  { limit: 10 }
);

for await (const checkpoint of checkpoints) {
  console.log(checkpoint.checkpoint.id);
}
```

##### `put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig>`

Save a checkpoint.

```typescript
const newConfig = await saver.put(config, checkpoint, metadata);
```

##### `putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void>`

Save pending writes for a checkpoint.

```typescript
await saver.putWrites(config, writes, "task-1");
```

##### `deleteThread(threadId: string): Promise<void>`

Delete all checkpoints and writes for a thread.

```typescript
await saver.deleteThread("thread-1");
console.log("Thread deleted");
```

##### `deleteCheckpoint(threadId: string, checkpointId: string, checkpointNs?: string): boolean`

Delete a specific checkpoint. Returns true if deleted, false if not found.

```typescript
const deleted = saver.deleteCheckpoint("thread-1", "checkpoint-123");
```

##### `getStats(): CheckpointStats`

Get statistics about the stored data.

```typescript
const stats = saver.getStats();
console.log(`Total checkpoints: ${stats.totalCheckpoints}`);
console.log(`Total writes: ${stats.totalWrites}`);
console.log(`Total threads: ${stats.totalThreads}`);
```

##### `close(): void`

Close the database connection. Should be called when done with the saver.

```typescript
saver.close();
```

## Database Schema

The implementation uses two tables:

### checkpoints

Stores checkpoint data.

| Column | Type | Description |
|--------|------|-------------|
| thread_id | TEXT | Thread identifier |
| checkpoint_ns | TEXT | Checkpoint namespace (default: "") |
| checkpoint_id | TEXT | Checkpoint identifier |
| parent_checkpoint_id | TEXT | Parent checkpoint ID (nullable) |
| type | TEXT | Serialization type |
| checkpoint | BLOB | Serialized checkpoint data |
| metadata | BLOB | Serialized metadata |

**Primary Key:** (thread_id, checkpoint_ns, checkpoint_id)

### checkpoint_writes

Stores pending writes associated with checkpoints.

| Column | Type | Description |
|--------|------|-------------|
| thread_id | TEXT | Thread identifier |
| checkpoint_ns | TEXT | Checkpoint namespace |
| checkpoint_id | TEXT | Checkpoint identifier |
| task_id | TEXT | Task identifier |
| idx | INTEGER | Write index |
| channel | TEXT | Channel name |
| type | TEXT | Serialization type |
| value | BLOB | Serialized value |

**Primary Key:** (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)

## TypeScript Configuration

This package is built with strict TypeScript settings and requires proper configuration in your project:

```json
{
  "compilerOptions": {
    "strict": true,
    "alwaysStrict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "types": ["bun-types"]
  }
}
```

## Development

### Type Checking

```bash
bun run typecheck
```

### Project Structure

```
.
├── index.ts          # Main implementation
├── package.json      # Package configuration
├── tsconfig.json     # TypeScript configuration
└── README.md         # Documentation
```

## Best Practices

### 1. Always Close Connections

```typescript
const saver = new BunSqliteSaver({ dbPath: "./checkpoints.db" });
try {
  // Use saver
} finally {
  saver.close();
}
```

### 2. Use Descriptive Thread IDs

```typescript
const userId = "user-123";
const sessionId = "session-456";
const threadId = `${userId}:${sessionId}`;

const config = { configurable: { thread_id: threadId } };
```

### 3. Regular Cleanup

```typescript
// Clean up old threads periodically
const oldThreads = await findOldThreads();
for (const threadId of oldThreads) {
  await saver.deleteThread(threadId);
}
```

### 4. Monitor Storage

```typescript
// Check storage stats regularly
const stats = saver.getStats();
if (stats.totalCheckpoints > 10000) {
  console.warn("High checkpoint count, consider cleanup");
}
```

## Error Handling

The saver will throw errors in the following cases:

- Missing required `thread_id` in config
- Missing required `checkpoint_id` when calling `putWrites`
- Database connection errors
- Serialization/deserialization errors

Always wrap operations in try-catch blocks:

```typescript
try {
  await saver.put(config, checkpoint, metadata);
} catch (error) {
  console.error("Failed to save checkpoint:", error);
  // Handle error appropriately
}
```

## Performance Considerations

- **Indexes**: The schema includes indexes on frequently queried columns
- **Batch Operations**: Use transactions for multiple operations (future enhancement)
- **In-Memory**: Use `:memory:` for development and testing
- **File-Based**: Use file-based databases for production persistence

## Limitations

- **Bun Only**: This package requires Bun runtime and will not work with Node.js
- **SQLite Limitations**: Subject to SQLite's limitations (file locking, etc.)
- **No Migrations**: Schema changes require manual migration

## Contributing

Contributions are welcome! Please ensure:

1. All code passes `bun run typecheck`
2. No `any` types are used
3. Code follows existing style
4. Documentation is updated

## License

MIT

## Related Projects

- [LangGraph.js](https://github.com/langchain-ai/langgraphjs) - The main LangGraph framework
- [@langchain/langgraph-checkpoint](https://www.npmjs.com/package/@langchain/langgraph-checkpoint) - Base checkpoint interfaces
- [Bun](https://bun.sh/) - The JavaScript runtime

## Support

For issues and questions:
- GitHub Issues: [Report a bug](https://github.com/tarnishablec/langgraph-checkpoint-bunsqlite/issues)
- Documentation: This README
- LangGraph Docs: [LangGraph Documentation](https://langchain-ai.github.io/langgraphjs/)
