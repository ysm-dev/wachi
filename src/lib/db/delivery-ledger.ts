import { and, asc, eq } from "drizzle-orm";
import type { WachiDb, WachiDbSession } from "./connect.ts";
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

type NormalizedDeliveryAdmission = Omit<DeliveryAdmission, "linkKey" | "availableAt"> & {
  linkKey: Buffer;
  availableAt: number;
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
  return admitDeliveriesWithOutbox(db, [admission])[0] ?? false;
};

const normalizeAdmission = (admission: DeliveryAdmission): NormalizedDeliveryAdmission => {
  validateDestinationId(admission.destinationId);
  const availableAt = admission.availableAt ?? Date.now();
  if (!Number.isSafeInteger(availableAt) || availableAt < 0) {
    throw new RangeError("availableAt must be a non-negative integer");
  }
  return {
    ...admission,
    linkKey: normalizeDatabaseKey(admission.linkKey, "linkKey"),
    availableAt,
  };
};

export const admitDeliveryWithOutboxInTransaction = (
  db: WachiDbSession,
  admission: DeliveryAdmission,
): boolean => {
  const normalized = normalizeAdmission(admission);
  const inserted = db
    .insert(deliveryKeys)
    .values({ destinationId: normalized.destinationId, linkKey: normalized.linkKey })
    .onConflictDoNothing()
    .returning({ destinationId: deliveryKeys.destinationId })
    .get();
  if (!inserted) {
    return false;
  }

  db.insert(deliveryOutbox)
    .values({
      destinationId: normalized.destinationId,
      linkKey: normalized.linkKey,
      payload: normalized.payload,
      source: normalized.source,
      link: normalized.link,
      enqueuedSeq: nextOutboxSequence(),
      availableAt: normalized.availableAt,
    })
    .run();
  return true;
};

export const admitDeliveriesWithOutbox = (
  db: WachiDb,
  admissions: DeliveryAdmission[],
): boolean[] => {
  if (admissions.length === 0) {
    return [];
  }

  const normalizedAdmissions = admissions.map(normalizeAdmission);

  return db.transaction(
    (tx) => {
      const results: boolean[] = [];
      for (const admission of normalizedAdmissions) {
        results.push(admitDeliveryWithOutboxInTransaction(tx, admission));
      }
      return results;
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
