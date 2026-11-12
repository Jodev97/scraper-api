import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWebhookSignature } from '../../src/security/crypto.js';
import type { WebhookBody } from '../../src/contract/schemas.js';

export interface ReceivedWebhook {
  body: WebhookBody;
  raw: string;
  headers: http.IncomingHttpHeaders;
  signatureValid: boolean;
  status: number;
}

export interface Receiver {
  url: string;
  secret: string;
  /** Every request, including the ones answered with an error. */
  attempts: ReceivedWebhook[];
  /** Only the ones answered 2xx. */
  delivered(): WebhookBody[];
  forRun(runId: string): WebhookBody[];
  /** Decide the HTTP status for each request (default 200). */
  respond: (req: { body: WebhookBody; attempt: number }) => number;
  close(): Promise<void>;
}

export async function startReceiver(secret = 'test-webhook-secret-0123456789'): Promise<Receiver> {
  const attempts: ReceivedWebhook[] = [];
  const perDelivery = new Map<string, number>();

  const receiver: Receiver = {
    url: '',
    secret,
    attempts,
    delivered: () => attempts.filter((a) => a.status >= 200 && a.status < 300).map((a) => a.body),
    forRun: (runId) => receiver.delivered().filter((b) => b.runId === runId),
    respond: () => 200,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw) as WebhookBody;
      const ts = String(req.headers['x-timestamp'] ?? '');
      const sig = String(req.headers['x-signature'] ?? '');
      const n = (perDelivery.get(body.deliveryId) ?? 0) + 1;
      perDelivery.set(body.deliveryId, n);
      const status = receiver.respond({ body, attempt: n });
      attempts.push({
        body,
        raw,
        headers: req.headers,
        signatureValid: verifyWebhookSignature(secret, ts, raw, sig),
        status,
      });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  receiver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/scraper`;
  return receiver;
}
