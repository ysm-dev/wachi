import { and, asc, eq } from "drizzle-orm";
import type { WachiDb } from "./connect.ts";
import { deliveryKeys, deliveryOutbox, destinations } from "./schema.ts";

export type DatabaseKey = Buffer | Uint8Array;

export type DeliveryAdmission = {
  destinationId: number;
  linkKey: DatabaseKey;
  payload: string;
  source: string;
  link: string;
  availableAt?: number;
};

// Process-monotonic admission sequence. Seeded from the wall clock so ordering
// stays roughly time-consistent across restarts; `available_at` remains the
// primary sort key, so this only breaks ties within a single admission batch.
let outboxSequence = Date.now();
const nextOutboxSequence = (): number => {
  outboxSequence += 1;
  return outboxSequence;
};

export const normalizeDatabaseKey = (key: DatabaseKey, label: string): Buffer => {
  const normalized = Buffer.from(key);
  if (normalized.byteLength !== 32) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
  return normalized;
};

const validateDestinationId = (destinationId: number): void => {
  if (!Number.isSafeInteger(destinationId) || destinationId <= 0) {
    throw new RangeError("destinationId must be a positive integer");
  }
};

export const resolveDestinationId = (db: WachiDb, destinationKey: DatabaseKey): number => {
  const identityKey = normalizeDatabaseKey(destinationKey, "destinationKey");
  const inserted = db
    .insert(destinations)
    .values({ identityKey })
    .onConflictDoNothing({ target: destinations.identityKey })
    .returning({ id: destinations.id })
    .get();

  if (inserted) {
    return inserted.id;
  }

  const existing = db
    .select({ id: destinations.id })
    .from(destinations)
    .where(eq(destinations.identityKey, identityKey))
    .get();
  if (!existing) {
    throw new Error("Failed to resolve destination ID");
  }
  return existing.id;
};

export const admitDeliveryKey = (
  db: WachiDb,
  destinationId: number,
  linkKey: DatabaseKey,
): boolean => {
  validateDestinationId(destinationId);
  const normalizedLinkKey = normalizeDatabaseKey(linkKey, "linkKey");
  const inserted = db
    .insert(deliveryKeys)
    .values({ destinationId, linkKey: normalizedLinkKey })
    .onConflictDoNothing()
    .returning({ destinationId: deliveryKeys.destinationId })
    .get();
  return inserted !== undefined;
};

export const hasDeliveryKey = (
  db: WachiDb,
  destinationId: number,
  linkKey: DatabaseKey,
): boolean => {
  validateDestinationId(destinationId);
  const normalizedLinkKey = normalizeDatabaseKey(linkKey, "linkKey");
  return (
    db
      .select({ destinationId: deliveryKeys.destinationId })
      .from(deliveryKeys)
      .where(
        and(
          eq(deliveryKeys.destinationId, destinationId),
          eq(deliveryKeys.linkKey, normalizedLinkKey),
        ),
      )
      .get() !== undefined
  );
};

export const admitDeliveryKeys = (
  db: WachiDb,
  destinationId: number,
  linkKeys: DatabaseKey[],
): number => {
  validateDestinationId(destinationId);
  return db.transaction(
    (tx) => {
      let inserted = 0;
      for (const key of linkKeys) {
        const linkKey = normalizeDatabaseKey(key, "linkKey");
        const row = tx
          .insert(deliveryKeys)
          .values({ destinationId, linkKey })
          .onConflictDoNothing()
          .returning({ destinationId: deliveryKeys.destinationId })
          .get();
        if (row) {
          inserted += 1;
        }
      }
      return inserted;
    },
    { behavior: "immediate" },
  );
};

export const admitDeliveryWithOutbox = (db: WachiDb, admission: DeliveryAdmission): boolean => {
  validateDestinationId(admission.destinationId);
  const linkKey = normalizeDatabaseKey(admission.linkKey, "linkKey");
  const availableAt = admission.availableAt ?? Date.now();
  if (!Number.isSafeInteger(availableAt) || availableAt < 0) {
    throw new RangeError("availableAt must be a non-negative integer");
  }

  return db.transaction(
    (tx) => {
      const inserted = tx
        .insert(deliveryKeys)
        .values({ destinationId: admission.destinationId, linkKey })
        .onConflictDoNothing()
        .returning({ destinationId: deliveryKeys.destinationId })
        .get();
      if (!inserted) {
        return false;
      }

      tx.insert(deliveryOutbox)
        .values({
          destinationId: admission.destinationId,
          linkKey,
          payload: admission.payload,
          source: admission.source,
          link: admission.link,
          enqueuedSeq: nextOutboxSequence(),
          availableAt,
        })
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
};

export const listDestinations = (db: WachiDb) => {
  return db.select().from(destinations).orderBy(asc(destinations.id)).all();
};

export const listDeliveryKeys = (db: WachiDb, destinationId?: number) => {
  if (destinationId === undefined) {
    return db
      .select()
      .from(deliveryKeys)
      .orderBy(asc(deliveryKeys.destinationId), asc(deliveryKeys.linkKey))
      .all();
  }

  validateDestinationId(destinationId);
  return db
    .select()
    .from(deliveryKeys)
    .where(eq(deliveryKeys.destinationId, destinationId))
    .orderBy(asc(deliveryKeys.linkKey))
    .all();
};
