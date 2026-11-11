import { getDatabase } from "../../../config/database";
import { logger } from "../../../shared/logger";
import { certificateExpiringEvent, certificateRenewalFailedEvent } from "../../notifications/events";
import { dispatchNotification } from "../../notifications/operations";
import type { StackportNotification } from "../../notifications/types";
import { getCertbotStatus, type CertbotEntry } from "./operations";

/** A certificate with fewer days than this left, that is still not renewed, is worth a notification. */
export const EXPIRY_WARNING_DAYS = 14;

const DAY_MS = 86_400_000;

/** What to tell the admin after a renewal sweep: a notification per certificate that is close to expiry (it should have been
 *  renewed by now), and one when the sweep itself failed. The keys carry the day, so each is sent once per certificate and day. */
export function certificateNotifications(entries: CertbotEntry[], renewalFailed: boolean, now: Date = new Date()): StackportNotification[] {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const out: StackportNotification[] = [];
  if (renewalFailed) out.push(certificateRenewalFailedEvent(day));
  for (const entry of entries) {
    if (!entry.hasCertificate || !entry.expiresAt) continue;
    const daysLeft = Math.ceil((Date.parse(entry.expiresAt) - now.getTime()) / DAY_MS);
    if (Number.isFinite(daysLeft) && daysLeft < EXPIRY_WARNING_DAYS) out.push(certificateExpiringEvent(entry.domain, daysLeft, day));
  }
  return out;
}

const alreadySent = (eventKey: string): boolean => !!getDatabase().prepare("SELECT 1 FROM push_events WHERE event_key = ?").get(eventKey);

/** Sends them, skipping any already sent today (a restart or a second sweep does not repeat a notification). Never throws:
 *  this runs inside background maintenance. */
export async function notifyAboutCertificates(renewalFailed: boolean, now: Date = new Date()): Promise<number> {
  try {
    const status = await getCertbotStatus();
    let sent = 0;
    for (const event of certificateNotifications(status.entries, renewalFailed, now)) {
      if (event.eventKey && alreadySent(event.eventKey)) continue;
      await dispatchNotification(event);
      sent += 1;
    }
    return sent;
  } catch (err) {
    logger.warn({ err }, "certificates: could not send notifications");
    return 0;
  }
}
