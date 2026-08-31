import { OrchestratorRuntime } from "../dist/runtime/runtime.js";

const runtime = new OrchestratorRuntime();
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log("HERMESS_WORKER_FLEET_STOPPING", JSON.stringify({ signal }));
  await runtime.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => console.error("worker-fleet-uncaught", error));
process.on("unhandledRejection", (error) => console.error("worker-fleet-rejection", error));

runtime.attachMaintenanceShutdown(() => shutdown("MAINTENANCE_SHUTDOWN"));
await runtime.start({ scheduler: false });
console.log("HERMESS_WORKER_FLEET_ONLINE", JSON.stringify({ pid: process.pid, scheduler: false, product_execution: 0 }));
setInterval(() => {}, 2_147_483_647);
