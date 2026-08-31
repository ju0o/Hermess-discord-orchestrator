import { OrchestratorRuntime } from "./runtime/runtime.js";

const runtime = new OrchestratorRuntime();
let stopping = false;
async function shutdown(signal: string) { if (stopping) return; stopping = true; console.log(`Stopping on ${signal}`); await runtime.stop(); process.exit(0); }
process.on("SIGINT", () => void shutdown("SIGINT")); process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => { console.error("uncaughtException", error); });
process.on("unhandledRejection", (error) => { console.error("unhandledRejection", error); });

await runtime.start();
console.log("HERMESS Discord Orchestrator ONLINE", { pid: process.pid });
