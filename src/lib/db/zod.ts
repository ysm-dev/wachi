import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";
import { health, meta, sentItems } from "./schema.ts";

export const sentItemSelectSchema = createSelectSchema(sentItems);
export const sentItemInsertSchema = createInsertSchema(sentItems);
export const sentItemUpdateSchema = createUpdateSchema(sentItems);

export const healthSelectSchema = createSelectSchema(health);
export const healthInsertSchema = createInsertSchema(health);
export const healthUpdateSchema = createUpdateSchema(health);

export const metaSelectSchema = createSelectSchema(meta);
export const metaInsertSchema = createInsertSchema(meta);
export const metaUpdateSchema = createUpdateSchema(meta);

export const sentItemListSchema = z.array(sentItemSelectSchema);
export const healthListSchema = z.array(healthSelectSchema);
export const metaListSchema = z.array(metaSelectSchema);

export type SentItemRow = z.infer<typeof sentItemSelectSchema>;
export type SentItemInsert = z.infer<typeof sentItemInsertSchema>;
export type SentItemUpdate = z.infer<typeof sentItemUpdateSchema>;

export type HealthRow = z.infer<typeof healthSelectSchema>;
export type HealthInsert = z.infer<typeof healthInsertSchema>;
export type HealthUpdate = z.infer<typeof healthUpdateSchema>;

export type MetaRow = z.infer<typeof metaSelectSchema>;
export type MetaInsert = z.infer<typeof metaInsertSchema>;
export type MetaUpdate = z.infer<typeof metaUpdateSchema>;
