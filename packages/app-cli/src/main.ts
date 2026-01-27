import "dotenv/config";
import { runAgent } from "./runtime/runAgent.js";

runAgent().catch((e) => {
  console.error(e);
  process.exit(1);
});
