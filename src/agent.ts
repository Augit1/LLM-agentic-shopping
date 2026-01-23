// src/agent.ts
import "dotenv/config";
import { runAgent } from "./agent/run.js";

runAgent().catch((e) => {
  console.error(e);
  process.exit(1);
});
