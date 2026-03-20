import { unstickBopoRuntime } from "./clear.mjs";

void unstickBopoRuntime().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[unstick] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
