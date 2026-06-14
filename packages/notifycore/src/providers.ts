import { createLogger } from '@portfolio/shared';
import type { Channel } from '@portfolio/notifycore-core';

export interface RenderedMessage {
  /**
   * Stable per-notification id (the client's idempotency key). Delivery is at-least-once — a worker
   * crash after a successful send but before the DB commit causes a redelivery — so providers SHOULD
   * dedupe on this token to make the end-to-end guarantee effectively exactly-once.
   */
  deliveryId: string;
  channel: Channel;
  recipient: string;
  subject: string | null;
  body: string;
}

export interface ChannelProvider {
  send(msg: RenderedMessage): Promise<void>;
}

const log = createLogger('notifycore:provider');

/**
 * ConsoleProvider: default provider that logs the rendered message and resolves.
 * Useful for development and tests that don't need to assert on delivery.
 */
export class ConsoleProvider implements ChannelProvider {
  async send(msg: RenderedMessage): Promise<void> {
    log.info(
      {
        deliveryId: msg.deliveryId,
        channel: msg.channel,
        recipient: msg.recipient,
        subject: msg.subject,
        bodyLength: msg.body.length,
      },
      'notification sent (console provider)',
    );
  }
}
