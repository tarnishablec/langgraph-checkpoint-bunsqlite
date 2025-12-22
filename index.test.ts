/**
 * Tests for BunSqliteSaver
 *
 * Comprehensive test suite ensuring full functionality and test coverage
 */

import {describe, test, expect, beforeEach, afterEach} from "bun:test";
import {Database} from "bun:sqlite";
import {BunSqliteSaver} from "index";
import type {Checkpoint, CheckpointMetadata, PendingWrite} from "@langchain/langgraph-checkpoint";

describe("BunSqliteSaver", () => {
    let saver: BunSqliteSaver;

    const createCheckpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
        v: 1,
        id: "checkpoint-1",
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
        ...overrides,
    });

    const createMetadata = (overrides: Partial<CheckpointMetadata> = {}): CheckpointMetadata => ({
        source: "input",
        step: 0,
        parents: {},
        ...overrides,
    });

    const createConfig = (threadId: string, checkpointId?: string, checkpointNs?: string) => ({
        configurable: {
            thread_id: threadId,
            ...(checkpointId ? {checkpoint_id: checkpointId} : {}),
            ...(checkpointNs ? {checkpoint_ns: checkpointNs} : {}),
        },
    });

    beforeEach(() => {
        // Create a new in-memory saver for each test
        saver = new BunSqliteSaver({dbPath: ":memory:"});
    });

    afterEach(() => {
        // Clean up
        saver.close();
    });

    describe("Constructor", () => {
        test("should create an in-memory saver by default", () => {
            const defaultSaver = new BunSqliteSaver();
            expect(defaultSaver).toBeDefined();
            defaultSaver.close();
        });

        test("should create a file-based saver", () => {
            const fileSaver = new BunSqliteSaver({dbPath: ":memory:"});
            expect(fileSaver).toBeDefined();
            fileSaver.close();
        });

        test("should accept custom serializer", () => {
            const customSaver = new BunSqliteSaver({
                dbPath: ":memory:",
                serializer: undefined,
            });
            expect(customSaver).toBeDefined();
            customSaver.close();
        });
    });

    describe("fromDatabase", () => {
        test("should create saver from existing database", () => {
            const db = new Database(":memory:");
            const fromDbSaver = BunSqliteSaver.fromDatabase(db);
            expect(fromDbSaver).toBeDefined();

            // Should not close the database when close() is called
            fromDbSaver.close();

            // Database should still be usable
            expect(() => db.query("SELECT 1").get()).not.toThrow();

            db.close();
        });

        test("should set up tables on existing database", () => {
            const db = new Database(":memory:");
            BunSqliteSaver.fromDatabase(db);

            // Check that tables exist
            const tables = db.query<{ name: string }, []>(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).all();

            const tableNames = tables.map(t => t.name);
            expect(tableNames).toContain("checkpoints");
            expect(tableNames).toContain("checkpoint_writes");

            db.close();
        });
    });

    describe("fromConnString", () => {
        test("should create saver from connection string", () => {
            const fromConnSaver = BunSqliteSaver.fromConnString(":memory:");
            expect(fromConnSaver).toBeDefined();
            fromConnSaver.close();
        });

        test("should create file-based saver from connection string", () => {
            const fromConnSaver = BunSqliteSaver.fromConnString(":memory:");
            expect(fromConnSaver).toBeDefined();
            fromConnSaver.close();
        });

        test("should accept custom serializer", () => {
            const fromConnSaver = BunSqliteSaver.fromConnString(":memory:", undefined);
            expect(fromConnSaver).toBeDefined();
            fromConnSaver.close();
        });

        test("should set up tables", () => {
            const fromConnSaver = BunSqliteSaver.fromConnString(":memory:");
            const stats = fromConnSaver.getStats();
            expect(stats).toBeDefined();
            expect(stats.totalCheckpoints).toBe(0);
            fromConnSaver.close();
        });
    });

    describe("put", () => {
        test("should save a checkpoint", async () => {
            const checkpoint = createCheckpoint({
                id: "checkpoint-1",
                channel_values: {test: "value"},
                channel_versions: {test: 1},
            });
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            const savedConfig = await saver.put(config, checkpoint, metadata);

            expect(savedConfig.configurable?.thread_id).toBe("thread-1");
            expect(savedConfig.configurable?.checkpoint_id).toBe("checkpoint-1");
        });

        test("should save checkpoint with parent", async () => {
            const checkpoint = createCheckpoint({id: "checkpoint-2"});
            const metadata = createMetadata({source: "loop", step: 1});
            const config = createConfig("thread-1", "checkpoint-1");

            const savedConfig = await saver.put(config, checkpoint, metadata);
            expect(savedConfig.configurable?.checkpoint_id).toBe("checkpoint-2");
        });

        test("should throw error if thread_id is missing", async () => {
            const checkpoint = createCheckpoint();
            const metadata = createMetadata();
            const config = {configurable: {}};

            expect(saver.put(config, checkpoint, metadata)).rejects.toThrow(
                "thread_id is required"
            );
        });

        test("should handle checkpoint_ns parameter", async () => {
            const checkpoint = createCheckpoint();
            const metadata = createMetadata();
            const config = createConfig("thread-1", undefined, "custom-namespace");

            const savedConfig = await saver.put(config, checkpoint, metadata);
            expect(savedConfig.configurable?.checkpoint_ns).toBe("custom-namespace");
        });
    });

    describe("get", () => {
        test("should retrieve just the checkpoint without tuple", async () => {
            const checkpoint = createCheckpoint({
                id: "checkpoint-1",
                channel_values: {test: "value"},
                channel_versions: {test: 1},
            });
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            await saver.put(config, checkpoint, metadata);

            const retrievedCheckpoint = await saver.get(createConfig("thread-1", "checkpoint-1"));

            expect(retrievedCheckpoint).toBeDefined();
            expect(retrievedCheckpoint?.id).toBe("checkpoint-1");
            expect(retrievedCheckpoint?.channel_values.test).toBe("value");
        });

        test("should return undefined for non-existent checkpoint", async () => {
            const checkpoint = await saver.get(createConfig("non-existent", "non-existent"));
            expect(checkpoint).toBeUndefined();
        });

        test("should return undefined when thread_id is missing", async () => {
            const checkpoint = await saver.get({configurable: {}});
            expect(checkpoint).toBeUndefined();
        });

        test("should retrieve latest checkpoint when checkpoint_id not specified", async () => {
            const checkpoint1 = createCheckpoint({id: "checkpoint-1", channel_values: {version: 1}});
            const checkpoint2 = createCheckpoint({id: "checkpoint-2", channel_values: {version: 2}});
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            await saver.put(config, checkpoint1, metadata);
            await saver.put(config, checkpoint2, metadata);

            const retrievedCheckpoint = await saver.get(config);

            expect(retrievedCheckpoint).toBeDefined();
            expect(retrievedCheckpoint?.id).toBe("checkpoint-2");
            expect(retrievedCheckpoint?.channel_values.version).toBe(2);
        });
    });

    describe("getTuple", () => {
        test("should retrieve saved checkpoint", async () => {
            const checkpoint = createCheckpoint({
                id: "checkpoint-1",
                channel_values: {test: "value"},
                channel_versions: {test: 1},
            });
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            await saver.put(config, checkpoint, metadata);

            const tuple = await saver.getTuple(createConfig("thread-1", "checkpoint-1"));

            expect(tuple).toBeDefined();
            expect(tuple?.checkpoint.id).toBe("checkpoint-1");
            expect(tuple?.checkpoint.channel_values.test).toBe("value");
            expect(tuple?.metadata?.step).toBe(0);
        });

        test("should retrieve latest checkpoint when checkpoint_id not specified", async () => {
            const checkpoint1 = createCheckpoint({id: "checkpoint-1"});
            const checkpoint2 = createCheckpoint({id: "checkpoint-2"});
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            await saver.put(config, checkpoint1, metadata);
            await saver.put(config, checkpoint2, metadata);

            const tuple = await saver.getTuple(config);

            expect(tuple).toBeDefined();
            expect(tuple?.checkpoint.id).toBe("checkpoint-2");
        });

        test("should return undefined for non-existent checkpoint", async () => {
            const tuple = await saver.getTuple(createConfig("non-existent", "non-existent"));
            expect(tuple).toBeUndefined();
        });

        test("should return undefined when thread_id is missing", async () => {
            const tuple = await saver.getTuple({configurable: {}});
            expect(tuple).toBeUndefined();
        });

        test("should include parent config when available", async () => {
            const checkpoint1 = createCheckpoint({id: "checkpoint-1"});
            const checkpoint2 = createCheckpoint({id: "checkpoint-2"});
            const metadata = createMetadata();

            await saver.put(createConfig("thread-1"), checkpoint1, metadata);
            await saver.put(createConfig("thread-1", "checkpoint-1"), checkpoint2, metadata);

            const tuple = await saver.getTuple(createConfig("thread-1", "checkpoint-2"));

            expect(tuple?.parentConfig).toBeDefined();
            expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe("checkpoint-1");
        });
    });

    describe("putWrites", () => {
        test("should save pending writes", async () => {
            const checkpoint = createCheckpoint({id: "checkpoint-1"});
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            const savedConfig = await saver.put(config, checkpoint, metadata);

            const writes: PendingWrite[] = [
                ["channel1", {data: "value1"}],
                ["channel2", {data: "value2"}],
            ];

            await saver.putWrites(savedConfig, writes, "task-1");

            const tuple = await saver.getTuple(savedConfig);
            expect(tuple?.pendingWrites).toBeDefined();
            expect(tuple?.pendingWrites?.length).toBe(2);
        });

        test("should throw error if thread_id is missing", async () => {
            const writes: PendingWrite[] = [["channel1", {data: "value1"}]];
            expect(
                saver.putWrites({configurable: {}}, writes, "task-1")
            ).rejects.toThrow("thread_id is required");
        });

        test("should throw error if checkpoint_id is missing", async () => {
            const writes: PendingWrite[] = [["channel1", {data: "value1"}]];
            expect(
                saver.putWrites(
                    createConfig("thread-1"),
                    writes,
                    "task-1"
                )
            ).rejects.toThrow("checkpoint_id is required");
        });

        test("should preserve write order", async () => {
            const checkpoint = createCheckpoint({id: "checkpoint-1"});
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            const savedConfig = await saver.put(config, checkpoint, metadata);

            const writes: PendingWrite[] = [
                ["channel1", {index: 0}],
                ["channel2", {index: 1}],
                ["channel3", {index: 2}],
            ];

            await saver.putWrites(savedConfig, writes, "task-1");

            const tuple = await saver.getTuple(savedConfig);
            expect(tuple?.pendingWrites?.[0]?.[1]).toBe("channel1");
            expect(tuple?.pendingWrites?.[1]?.[1]).toBe("channel2");
            expect(tuple?.pendingWrites?.[2]?.[1]).toBe("channel3");
        });
    });

    describe("list", () => {
        test("should list all checkpoints for a thread", async () => {
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            // Create multiple checkpoints
            for (let i = 1; i <= 3; i++) {
                await saver.put(config, createCheckpoint({id: `checkpoint-${i}`}), metadata);
            }

            const checkpoints = [];
            for await (const tuple of saver.list(config)) {
                checkpoints.push(tuple);
            }

            expect(checkpoints.length).toBe(3);
        });

        test("should list checkpoints in descending order", async () => {
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            // Create checkpoints with specific IDs
            await saver.put(config, createCheckpoint({id: "checkpoint-1"}), metadata);
            await saver.put(config, createCheckpoint({id: "checkpoint-3"}), metadata);
            await saver.put(config, createCheckpoint({id: "checkpoint-2"}), metadata);

            const checkpoints = [];
            for await (const tuple of saver.list(config)) {
                checkpoints.push(tuple);
            }

            expect(checkpoints[0]?.checkpoint.id).toBe("checkpoint-3");
            expect(checkpoints[1]?.checkpoint.id).toBe("checkpoint-2");
            expect(checkpoints[2]?.checkpoint.id).toBe("checkpoint-1");
        });

        test("should respect limit option", async () => {
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            for (let i = 1; i <= 5; i++) {
                await saver.put(config, createCheckpoint({id: `checkpoint-${i}`}), metadata);
            }

            const checkpoints = [];
            for await (const tuple of saver.list(config, {limit: 2})) {
                checkpoints.push(tuple);
            }

            expect(checkpoints.length).toBe(2);
        });

        test("should respect before option", async () => {
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            for (let i = 1; i <= 5; i++) {
                await saver.put(config, createCheckpoint({id: `checkpoint-${i}`}), metadata);
            }

            const checkpoints = [];
            for await (const tuple of saver.list(config, {
                before: createConfig("thread-1", "checkpoint-3"),
            })) {
                checkpoints.push(tuple);
            }

            // Should only get checkpoints before checkpoint-3
            expect(checkpoints.every(cp => cp.checkpoint.id < "checkpoint-3")).toBe(true);
        });

        test("should filter by metadata", async () => {
            const config = createConfig("thread-1");

            await saver.put(config, createCheckpoint({id: "checkpoint-1"}), createMetadata({source: "input", step: 0}));
            await saver.put(config, createCheckpoint({id: "checkpoint-2"}), createMetadata({source: "loop", step: 1}));

            const checkpoints = [];
            for await (const tuple of saver.list(config, {
                filter: {source: "loop"},
            })) {
                checkpoints.push(tuple);
            }

            expect(checkpoints.length).toBe(1);
            expect(checkpoints[0]?.checkpoint.id).toBe("checkpoint-2");
        });

        test("should return empty for non-existent thread", async () => {
            const checkpoints = [];
            for await (const tuple of saver.list(createConfig("non-existent"))) {
                checkpoints.push(tuple);
            }

            expect(checkpoints.length).toBe(0);
        });

        test("should return empty when thread_id is missing", async () => {
            const checkpoints = [];
            for await (const tuple of saver.list({configurable: {}})) {
                checkpoints.push(tuple);
            }

            expect(checkpoints.length).toBe(0);
        });
    });

    describe("deleteThread", () => {
        test("should delete all checkpoints for a thread", async () => {
            const metadata = createMetadata();
            const config = createConfig("thread-1");

            // Create checkpoints
            for (let i = 1; i <= 3; i++) {
                await saver.put(config, createCheckpoint({id: `checkpoint-${i}`}), metadata);
            }

            await saver.deleteThread("thread-1");

            const tuple = await saver.getTuple(config);
            expect(tuple).toBeUndefined();
        });

        test("should not throw for non-existent thread", async () => {
            expect(saver.deleteThread("non-existent")).resolves.toBeUndefined();
        });

        test("should delete associated writes", async () => {
            const config = createConfig("thread-1");
            const savedConfig = await saver.put(config, createCheckpoint({id: "checkpoint-1"}), createMetadata());
            await saver.putWrites(savedConfig, [["channel1", {data: "value"}]], "task-1");

            await saver.deleteThread("thread-1");

            const tuple = await saver.getTuple(savedConfig);
            expect(tuple).toBeUndefined();
        });
    });

    describe("deleteCheckpoint", () => {
        test("should delete specific checkpoint", async () => {
            const config = createConfig("thread-1");
            await saver.put(config, createCheckpoint({id: "checkpoint-1"}), createMetadata());

            const deleted = saver.deleteCheckpoint("thread-1", "checkpoint-1");
            expect(deleted).toBe(true);

            const tuple = await saver.getTuple(createConfig("thread-1", "checkpoint-1"));
            expect(tuple).toBeUndefined();
        });

        test("should return false for non-existent checkpoint", () => {
            const deleted = saver.deleteCheckpoint("thread-1", "non-existent");
            expect(deleted).toBe(false);
        });

        test("should delete associated writes", async () => {
            const config = createConfig("thread-1");
            const savedConfig = await saver.put(config, createCheckpoint({id: "checkpoint-1"}), createMetadata());
            await saver.putWrites(savedConfig, [["channel1", {data: "value"}]], "task-1");

            saver.deleteCheckpoint("thread-1", "checkpoint-1");

            const tuple = await saver.getTuple(savedConfig);
            expect(tuple).toBeUndefined();
        });

        test("should respect checkpoint_ns parameter", async () => {
            const config = createConfig("thread-1", undefined, "namespace-1");
            await saver.put(config, createCheckpoint({id: "checkpoint-1"}), createMetadata());

            const deleted = saver.deleteCheckpoint("thread-1", "checkpoint-1", "namespace-1");
            expect(deleted).toBe(true);
        });
    });

    describe("getStats", () => {
        test("should return initial stats", () => {
            const stats = saver.getStats();
            expect(stats.totalCheckpoints).toBe(0);
            expect(stats.totalWrites).toBe(0);
            expect(stats.totalThreads).toBe(0);
        });

        test("should count checkpoints correctly", async () => {
            const metadata = createMetadata();

            for (let i = 1; i <= 3; i++) {
                await saver.put(
                    createConfig("thread-1"),
                    createCheckpoint({id: `checkpoint-${i}`}),
                    metadata
                );
            }

            const stats = saver.getStats();
            expect(stats.totalCheckpoints).toBe(3);
        });

        test("should count threads correctly", async () => {
            const metadata = createMetadata();
            const checkpoint = createCheckpoint();

            await saver.put(createConfig("thread-1"), checkpoint, metadata);
            await saver.put(createConfig("thread-2"), checkpoint, metadata);

            const stats = saver.getStats();
            expect(stats.totalThreads).toBe(2);
        });

        test("should count writes correctly", async () => {
            const config = createConfig("thread-1");
            const savedConfig = await saver.put(config, createCheckpoint(), createMetadata());

            await saver.putWrites(savedConfig, [
                ["channel1", {data: "value1"}],
                ["channel2", {data: "value2"}],
            ], "task-1");

            const stats = saver.getStats();
            expect(stats.totalWrites).toBe(2);
        });
    });

    describe("close", () => {
        test("should close database connection", () => {
            const tempSaver = new BunSqliteSaver({dbPath: ":memory:"});
            expect(() => tempSaver.close()).not.toThrow();
        });

        test("should not close externally owned database", () => {
            const db = new Database(":memory:");
            const fromDbSaver = BunSqliteSaver.fromDatabase(db);

            fromDbSaver.close();

            // Database should still be usable
            expect(() => db.query("SELECT 1").get()).not.toThrow();

            db.close();
        });
    });

    describe("Complex scenarios", () => {
        test("should handle multiple threads independently", async () => {
            const metadata = createMetadata();

            await saver.put(
                createConfig("thread-1"),
                createCheckpoint({id: "checkpoint-1", channel_values: {thread: 1}}),
                metadata
            );
            await saver.put(
                createConfig("thread-2"),
                createCheckpoint({id: "checkpoint-2", channel_values: {thread: 2}}),
                metadata
            );

            const tuple1 = await saver.getTuple(createConfig("thread-1"));
            const tuple2 = await saver.getTuple(createConfig("thread-2"));

            expect(tuple1?.checkpoint.channel_values.thread).toBe(1);
            expect(tuple2?.checkpoint.channel_values.thread).toBe(2);
        });

        test("should handle complex channel values", async () => {
            const checkpoint = createCheckpoint({
                channel_values: {
                    messages: ["msg1", "msg2"],
                    state: {counter: 42, flag: true},
                    data: null,
                },
            });

            const config = createConfig("thread-1");
            await saver.put(config, checkpoint, createMetadata());

            const tuple = await saver.getTuple(config);
            expect(tuple?.checkpoint.channel_values.messages).toEqual(["msg1", "msg2"]);
            expect(tuple?.checkpoint.channel_values.state).toEqual({counter: 42, flag: true});
        });

        test("should handle checkpoints across multiple namespaces", async () => {
            const checkpoint = createCheckpoint();
            const metadata = createMetadata();

            await saver.put(createConfig("thread-1", undefined, "ns1"), checkpoint, metadata);
            await saver.put(createConfig("thread-1", undefined, "ns2"), checkpoint, metadata);

            const tuple1 = await saver.getTuple(createConfig("thread-1", undefined, "ns1"));
            const tuple2 = await saver.getTuple(createConfig("thread-1", undefined, "ns2"));

            expect(tuple1).toBeDefined();
            expect(tuple2).toBeDefined();
            expect(tuple1?.config.configurable?.checkpoint_ns).toBe("ns1");
            expect(tuple2?.config.configurable?.checkpoint_ns).toBe("ns2");
        });
    });
});
