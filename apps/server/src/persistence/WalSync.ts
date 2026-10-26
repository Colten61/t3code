// @effect-diagnostics nodeBuiltinImport:off - a worker thread that fdatasyncs the WAL, which effect/FileSystem does not expose
import * as NodeWorkerThreads from "node:worker_threads";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

// NORMAL commits need a worker WAL sync each second to bound power-loss rollback without per-event fsyncs.
// The worker stays responsive during main-thread SQLite busy waits; unchanged WALs need no I/O.
// Open only the WAL: closing database or shm descriptors here would drop SQLite's POSIX locks.
export const WAL_SYNC_INTERVAL = Duration.seconds(1);

const WORKER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
let reported = false;
const report = (error) => {
  if (reported) return;
  reported = true;
  parentPort.postMessage(String((error && error.message) || error));
};
setInterval(() => {
  let fd;
  try {
    // Write access: Windows needs it to flush a file.
    fd = fs.openSync(workerData.walPath, "r+");
  } catch (error) {
    if (error.code !== "ENOENT") report(error);
    return;
  }
  try {
    fs.fdatasyncSync(fd);
    reported = false;
  } catch (error) {
    report(error);
  } finally {
    fs.closeSync(fd);
  }
}, workerData.intervalMs);
`;

/** The WAL SQLite itself uses: its canonical database path (symlinks resolved) plus "-wal". */
export const walPathOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ readonly name: string; readonly file: string }>`
    PRAGMA database_list
  `;
  const file = databases.find((database) => database.name === "main")?.file;
  return file === undefined || file === "" ? undefined : `${file}-wal`;
});

export const layer: Layer.Layer<never, never, SqlClient.SqlClient> = Layer.effectDiscard(
  Effect.gen(function* () {
    const walPath = yield* walPathOf.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Cannot locate the SQLite WAL to sync", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (walPath === undefined) return;
    const worker = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new NodeWorkerThreads.Worker(WORKER_SOURCE, {
            eval: true,
            workerData: { walPath, intervalMs: Duration.toMillis(WAL_SYNC_INTERVAL) },
          }),
      ),
      (worker) => Effect.promise(() => worker.terminate()),
    );
    // Logging with this layer's context keeps the server's loggers. The worker
    // reports the first failure of a run of failures.
    const log = Effect.runForkWith(yield* Effect.context<never>());
    worker.on("message", (message) => {
      log(Effect.logWarning("Failed to sync the SQLite WAL", { walPath, message }));
    });
    worker.on("error", (cause) => {
      log(Effect.logWarning("The SQLite WAL sync worker stopped", { walPath, cause }));
    });
    // After the listeners: attaching a message listener refs the worker again.
    worker.unref();
  }),
);
