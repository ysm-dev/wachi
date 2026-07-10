import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { WachiDb } from "./connect.ts";
import { type DatabaseKey, normalizeDatabaseKey } from "./delivery-ledger.ts";
import { deliveryOutbox } from "./schema.ts";

export type DeliveryOutboxRecord = typeof deliveryOutbox.$inferSelect;

export type ClaimDeliveryOptions = {
  now?: number;
  leaseDurationMs?: number;
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

export const claimNextDelivery = (
  db: WachiDb,
  destinationId: number,
  options: ClaimDeliveryOptions = {},
): DeliveryOutboxRecord | undefined => {
  validateDestinationId(destinationId);
  const now = options.now ?? Date.now();
  const leaseDurationMs = options.leaseDurationMs ?? 60_000;
  validateTimestamp(now, "now");
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError("leaseDurationMs must be a positive integer");
  }
  const leaseExpiresAt = now + leaseDurationMs;
  if (!Number.isSafeInteger(leaseExpiresAt)) {
    throw new RangeError("lease expiration exceeds the safe integer range");
  }

  return db.transaction(
    (tx) => {
      tx.update(deliveryOutbox)
        .set({ state: "pending", leaseExpiresAt: null })
        .where(
          and(
            eq(deliveryOutbox.destinationId, destinationId),
            eq(deliveryOutbox.state, "reserved"),
            lte(deliveryOutbox.leaseExpiresAt, now),
          ),
        )
        .run();
      tx.update(deliveryOutbox)
        .set({ state: "uncertain", leaseExpiresAt: null })
        .where(
          and(
            eq(deliveryOutbox.destinationId, destinationId),
            eq(deliveryOutbox.state, "dispatching"),
            lte(deliveryOutbox.leaseExpiresAt, now),
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

      return tx
        .update(deliveryOutbox)
        .set({
          state: "reserved",
          attempts: sql`${deliveryOutbox.attempts} + 1`,
          leaseExpiresAt,
          lastError: null,
        })
        .where(deliveryIdentity(destinationId, pending.linkKey))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
};

export const markDeliveryDispatching = (
  db: WachiDb,
  destinationId: number,
  linkKey: DatabaseKey,
): boolean => {
  validateDestinationId(destinationId);
  const normalizedLinkKey = normalizeDatabaseKey(linkKey, "linkKey");
  const updated = db
    .update(deliveryOutbox)
    .set({ state: "dispatching" })
    .where(
      and(deliveryIdentity(destinationId, normalizedLinkKey), eq(deliveryOutbox.state, "reserved")),
    )
    .returning({ destinationId: deliveryOutbox.destinationId })
    .get();
  return updated !== undefined;
};

export const completeDeliverySuccess = (
  db: WachiDb,
  destinationId: number,
  linkKey: DatabaseKey,
): boolean => {
  validateDestinationId(destinationId);
  const normalizedLinkKey = normalizeDatabaseKey(linkKey, "linkKey");
  const deleted = db
    .delete(deliveryOutbox)
    .where(
      and(
        deliveryIdentity(destinationId, normalizedLinkKey),
        inArray(deliveryOutbox.state, ["reserved", "dispatching"]),
      ),
    )
    .returning({ destinationId: deliveryOutbox.destinationId })
    .get();
  return deleted !== undefined;
};

/**
 * Return a claimed delivery to `pending` for a later retry. Valid from either
 * `reserved` (never dispatched) or `dispatching` (dispatched but the provider
 * definitively rejected it, e.g. apprise exited non-zero), because in both
 * cases the message was not delivered.
 */
export const markDeliveryRetry = (
  db: WachiDb,
  destinationId: number,
  linkKey: DatabaseKey,
  error: string,
  backoffMs: number,
  now = Date.now(),
): boolean => {
  validateDestinationId(destinationId);
  validateTimestamp(now, "now");
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0) {
    throw new RangeError("backoffMs must be a non-negative integer");
  }
  const availableAt = now + backoffMs;
  if (!Number.isSafeInteger(availableAt)) {
    throw new RangeError("backoff expiration exceeds the safe integer range");
  }
  const normalizedLinkKey = normalizeDatabaseKey(linkKey, "linkKey");
  const updated = db
    .update(deliveryOutbox)
    .set({
      state: "pending",
      availableAt,
      leaseExpiresAt: null,
      lastError: error,
    })
    .where(
      and(
        deliveryIdentity(destinationId, normalizedLinkKey),
        inArray(deliveryOutbox.state, ["reserved", "dispatching"]),
      ),
    )
    .returning({ destinationId: deliveryOutbox.destinationId })
    .get();
  return updated !== undefined;
};

/**
 * Park a claimed delivery as `uncertain`: it is never retried automatically
 * because the provider may already have accepted it. Valid from `reserved`
 * (e.g. an internal error before dispatch) or `dispatching` (ambiguous outcome
 * such as a timeout that killed the subprocess mid-flight).
 */
export const markDeliveryUncertain = (
  db: WachiDb,
  destinationId: number,
  linkKey: DatabaseKey,
  error: string | null = null,
): boolean => {
  validateDestinationId(destinationId);
  const normalizedLinkKey = normalizeDatabaseKey(linkKey, "linkKey");
  const updated = db
    .update(deliveryOutbox)
    .set({ state: "uncertain", leaseExpiresAt: null, lastError: error })
    .where(
      and(
        deliveryIdentity(destinationId, normalizedLinkKey),
        inArray(deliveryOutbox.state, ["reserved", "dispatching"]),
      ),
    )
    .returning({ destinationId: deliveryOutbox.destinationId })
    .get();
  return updated !== undefined;
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
