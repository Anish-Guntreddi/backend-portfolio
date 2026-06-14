import { z } from 'zod';

/** Delivery channels NotifyCore knows how to route. The demo ships a console provider for each. */
export const CHANNELS = ['email', 'sms', 'push', 'webhook'] as const;
export type Channel = (typeof CHANNELS)[number];
export const channelSchema = z.enum(CHANNELS);

/**
 * Notification lifecycle:
 *   queued   -> accepted, a delivery job is enqueued
 *   sending  -> a worker has picked it up
 *   sent     -> delivered by the channel provider (terminal, success)
 *   deferred -> held for quiet hours; re-enqueued with a delay
 *   skipped  -> recipient opted out of this channel (terminal, no delivery)
 *   dead     -> exhausted all retries; sits in the DLQ until replayed (terminal until replay)
 */
export const NOTIFICATION_STATUSES = [
  'queued',
  'sending',
  'sent',
  'deferred',
  'skipped',
  'dead',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
