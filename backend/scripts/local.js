// Runs the API against a local MongoDB without installing MongoDB: uses the mongod binary that
// mongodb-memory-server downloads, with data kept in backend/local-data/db so it survives restarts.
// Everything else (ADMIN_API_KEY, CHAIN_MODE, ...) comes from backend/.env as usual.
// Usage (from backend/): npm run local
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { MongoMemoryServer } = require("mongodb-memory-server");

const DB_PATH = path.join(__dirname, "..", "local-data", "db");
const PORT = 27018; // not 27017, so it never clashes with a real MongoDB install

async function main() {
  fs.mkdirSync(DB_PATH, { recursive: true });
  const mongo = await MongoMemoryServer.create({ instance: { dbPath: DB_PATH, port: PORT, storageEngine: "wiredTiger" } });
  const uri = mongo.getUri("vericert");
  console.log(`Local MongoDB running (data in ${path.relative(process.cwd(), DB_PATH)})`);

  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    // .env is already loaded here, so the server's own dotenv would misleadingly report "injected env (0)".
    env: { ...process.env, MONGODB_URI: uri, DOTENV_CONFIG_QUIET: "true" },
    stdio: "inherit",
  });

  let stopping = false;
  const stop = async (code) => {
    if (stopping) return;
    stopping = true;
    await mongo.stop({ doCleanup: false }); // keep the data folder
    process.exit(code);
  };
  server.on("exit", (code) => stop(code ?? 0));
  // Ctrl+C reaches the server too; wait for it to exit, then stop MongoDB.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => server.kill());
}

main().catch((err) => {
  console.error("Could not start local MongoDB:", err.message);
  process.exit(1);
});
