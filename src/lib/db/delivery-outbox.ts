import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { WachiDb } from "./connect.ts";
import { type DatabaseKey, normalizeDatabaseKey } from "./delivery-ledger.ts";
import { deliveryKeys, deliveryOutbox } from "./schema.ts";

export type DeliveryOutboxRecord = typeof deliveryOutbox.$inferSelect;
export type ClaimedDeliveryOutboxRecord = DeliveryOutboxRecord & { claimOwner: string };

export type ClaimDeliveryOptions = {
  now?: number;
  leaseDurationMs?: number;
  claimOwner?: string;
};

export type DeliveryClaim = {
  destinationId: number;
  linkKey: DatabaseKey;
  claimGeneration: number;
  claimOwner: string;
};

const validateTimestamp = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
};

const validateDestinationId = (destinationId: number): void => {
  if (!Number.isSafeInteger(destinationId) || destinationId <= 0) {
    throw new RangeError("destinationId must be a positive integer");
  }
};

const deliveryIdentity = (destinationId: number, linkKey: Buffer) => {
  return and(eq(deliveryOutbox.destinationId, destinationId), eq(deliveryOutbox.linkKey, linkKey));
};

const claimedDeliveryIdentity = (claim: DeliveryClaim) => {
  validateDestinationId(claim.destinationId);
  if (!Number.isSafeInteger(claim.claimGeneration) || claim.claimGeneration <= 0) {
    throw new RangeError("claimGeneration must be a positive integer");
  }
  if (claim.claimOwner.length === 0) {
    throw new RangeError("claimOwner must not be empty");
  }
  return and(
    deliveryIdentity(claim.destinationId, normalizeDatabaseKey(claim.linkKey, "linkKey")),
    eq(deliveryOutbox.claimGeneration, claim.claimGeneration),
    eq(deliveryOutbox.claimOwner, claim.claimOwner),
  );
};

export const claimNextDelivery = (
  db: WachiDb,
  destinationId: number,
  options: ClaimDeliveryOptions = {},
): ClaimedDeliveryOutboxRecord | undefined => {
  validateDestinationId(destinationId);
  const now = options.now ?? Date.now();
  const leaseDurationMs = options.leaseDurationMs ?? 60_000;
  const claimOwner = options.claimOwner ?? randomUUID();
  validateTimestamp(now, "now");
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError("leaseDurationMs must be a positive integer");
  }
  if (claimOwner.length === 0) {
    throw new RangeError("claimOwner must not be empty");
  }
  const leaseExpiresAt = now + leaseDurationMs;
  if (!Number.isSafeInteger(leaseExpiresAt)) {
    throw new RangeError("lease expiration exceeds the safe integer range");
  }

  return db.transaction(
    (tx) => {
      tx.update(deliveryOutbox)
        .set({ state: "pending", leaseExpiresAt: null, claimOwner: null })
        .where(
          and(
            eq(deliveryOutbox.destinationId, destinationId),
            inArray(deliveryOutbox.state, ["reserved", "dispatching"]),
            lte(deliveryOutbox.leaseExpiresAt, now),
          ),
        )
        .run();
      tx.update(deliveryOutbox)
        .set({ state: "pending", leaseExpiresAt: null, claimOwner: null })
        .where(
          and(
            eq(deliveryOutbox.destinationId, destinationId),
            eq(deliveryOutbox.state, "uncertain"),
          ),
        )
        .run();

      const active = tx
        .select({ destinationId: deliveryOutbox.destinationId })
        .from(deliveryOutbox)
        .where(
          and(
            eq(deliveryOutbox.destinationId, destinationId),
            inArray(deliveryOutbox.state, ["reserved", "dispatching"]),
          ),
        )
        .get();
      if (active) {
        return undefined;
      }

      const pending = tx
        .select({ linkKey: deliveryOutbox.linkKey })
        .from(deliveryOutbox)
        .where(
          and(
            eq(deliveryOutbox.destinationId, destinationId),
            eq(deliveryOutbox.state, "pending"),
            lte(deliveryOutbox.availableAt, now),
          ),
        )
        .orderBy(asc(deliveryOutbox.availableAt), asc(deliveryOutbox.enqueuedSeq))
        .limit(1)
        .get();
      if (!pending) {
        return undefined;
      }

      const claimed = tx
        .update(deliveryOutbox)
        .set({
          state: "reserved",
          attempts: sql`${deliveryOutbox.attempts} + 1`,
          leaseExpiresAt,
          claimGeneration: sql`${deliveryOutbox.claimGeneration} + 1`,
          claimOwner,
          lastError: null,
        })
        .where(deliveryIdentity(destinationId, pending.linkKey))
        .returning()
        .get();
      if (!claimed?.claimOwner) {
        return undefined;
      }
      return { ...claimed, claimOwner: claimed.claimOwner };
    },
    { behavior: "immediate" },
  );
};

export const markDeliveryDispatching = (db: WachiDb, claim: DeliveryClaim): boolean => {
  const updated = db
    .update(deliveryOutbox)
    .set({ state: "dispatching" })
    .where(and(claimedDeliveryIdentity(claim), eq(deliveryOutbox.state, "reserved")))
    .returning({ destinationId: deliveryOutbox.destinationId })
    .get();
  return updated !== undefined;
};

export const completeDeliverySuccess = (db: WachiDb, claim: DeliveryClaim): boolean => {
  const deleted = db
    .delete(deliveryOutbox)
    .where(
      and(
        claimedDeliveryIdentity(claim),
        inArray(deliveryOutbox.state, ["reserved", "dispatching"]),
      ),
    )
    .returning({ destinationId: deliveryOutbox.destinationId })
    .get();
  return deleted !== undefined;
};

/**
 * Return a claimed delivery to `pending` for a later retry. Valid from either
 * `reserved` (never dispatched) or `dispatching` (where delivery may be
 * ambiguous). At-least-once delivery intentionally accepts possible duplicates.
 */
export const markDeliveryRetry = (
  db: WachiDb,
  claim: DeliveryClaim,
  error: string,
  backoffMs: number,
  now = Date.now(),
): boolean => {
  validateTimestamp(now, "now");
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0) {
    throw new RangeError("backoffMs must be a non-negative integer");
  }
  const availableAt = now + backoffMs;
  if (!Number.isSafeInteger(availableAt)) {
    throw new RangeError("backoff expiration exceeds the safe integer range");
  }
  const updated = db
    .update(deliveryOutbox)
    .set({
      state: "pending",
      availableAt,
      leaseExpiresAt: null,
      claimOwner: null,
      lastError: error,
    })
    .where(
      and(
        claimedDeliveryIdentity(claim),
        inArray(deliveryOutbox.state, ["reserved", "dispatching"]),
      ),
    )
    .returning({ destinationId: deliveryOutbox.destinationId })
    .get();
  return updated !== undefined;
};

export const deleteQueuedDelivery = (
  db: WachiDb,
  destinationId: number,
  linkKey: DatabaseKey,
): boolean => {
  validateDestinationId(destinationId);
  const deleted = db
    .delete(deliveryOutbox)
    .where(
      and(
        deliveryIdentity(destinationId, normalizeDatabaseKey(linkKey, "linkKey")),
        inArray(deliveryOutbox.state, ["pending", "uncertain"]),
      ),
    )
    .returning({ destinationId: deliveryOutbox.destinationId })
    .get();
  return deleted !== undefined;
};

export const rehomeQueuedDelivery = (
  db: WachiDb,
  delivery: DeliveryOutboxRecord,
  destinationId: number,
): boolean => {
  validateDestinationId(destinationId);
  if (delivery.destinationId === destinationId) {
    return false;
  }
  const linkKey = normalizeDatabaseKey(delivery.linkKey, "linkKey");

  return db.transaction(
    (tx) => {
      tx.insert(deliveryKeys).values({ destinationId, linkKey }).onConflictDoNothing().run();
      tx.insert(deliveryOutbox)
        .values({
          destinationId,
          linkKey,
          payload: delivery.payload,
          source: delivery.source,
          link: delivery.link,
          enqueuedSeq: delivery.enqueuedSeq,
          availableAt: delivery.availableAt,
        })
        .onConflictDoNothing()
        .run();

      const targetExists = tx
        .select({ destinationId: deliveryOutbox.destinationId })
        .from(deliveryOutbox)
        .where(deliveryIdentity(destinationId, linkKey))
        .get();
      if (!targetExists) {
        return false;
      }

      tx.delete(deliveryOutbox)
        .where(
          and(
            deliveryIdentity(delivery.destinationId, linkKey),
            inArray(deliveryOutbox.state, ["pending", "uncertain"]),
          ),
        )
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
};

export const listDeliveryOutbox = (db: WachiDb, destinationId?: number) => {
  if (destinationId === undefined) {
    return db
      .select()
      .from(deliveryOutbox)
      .orderBy(
        asc(deliveryOutbox.destinationId),
        asc(deliveryOutbox.availableAt),
        asc(deliveryOutbox.enqueuedSeq),
      )
      .all();
  }

  validateDestinationId(destinationId);
  return db
    .select()
    .from(deliveryOutbox)
    .where(eq(deliveryOutbox.destinationId, destinationId))
    .orderBy(asc(deliveryOutbox.availableAt), asc(deliveryOutbox.enqueuedSeq))
    .all();
};
