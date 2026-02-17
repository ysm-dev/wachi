import type { WachiDb } from "./connect.ts";
import type { HealthState } from "./get-health-state.ts";
import { health } from "./schema.ts";
import { healthListSchema, healthSelectSchema } from "./zod.ts";

export const listHealthStates = (db: WachiDb): HealthState[] => {
  const rows = db.select().from(health).all();
  const parsed = healthListSchema.safeParse(rows);

  if (parsed.success) {
    return parsed.data;
  }

  const states: HealthState[] = [];
  for (const row of rows) {
    const rowParsed = healthSelectSchema.safeParse(row);
    if (rowParsed.success) {
      states.push(rowParsed.data);
    }
  }

  return states;
};
