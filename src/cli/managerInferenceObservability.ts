import { ManagerInferenceObservability } from "../observability/managerInference.js";
import { Store } from "../storage/database.js";

const args = process.argv.slice(2);
const index = args.indexOf("--last");
const limit = index >= 0 ? Number(args[index + 1]) : 20;
const store = new Store();
try { console.log(JSON.stringify(new ManagerInferenceObservability(store).recent(Number.isFinite(limit) ? limit : 20), null, 2)); }
finally { store.close(); }
