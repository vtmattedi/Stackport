import { Resend } from "resend";
import { randomUUID } from "crypto";

export interface SendParams {
  to: string;
  subject: string;
  html: string;
}

interface EmailProvider {
  send(params: SendParams): Promise<void>;
}

class ResendProvider implements EmailProvider {
  private client: Resend;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.client = new Resend(apiKey);
    this.from = from;
  }

  async send({ to, subject, html }: SendParams): Promise<void> {
    const result = await this.client.emails.send({ from: this.from, to, subject, html });
    if (result.error) throw new Error(result.error.message);
  }
}

// Fixed gateway address, not environment-configurable — every project talks to the
// same MW Email Gateway; only the per-project API key (from a credential) varies.
const MW_EMAIL_API_URL = "https://mailgo.mattediworks.com";

interface MwEmailErrorBody {
  error?: string;
}

class MwEmailProvider implements EmailProvider {
  private apiKey: string;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send({ to, subject, html }: SendParams): Promise<void> {
    const response = await fetch(`${MW_EMAIL_API_URL}/v1/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        // One send call = one logical operation, so a fresh key per call is correct:
        // this class doesn't retry internally, and each caller invocation represents
        // a genuinely new email, not a retry of a previous attempt.
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ from: this.from, to: [to], subject, html }),
    });

    if (!response.ok) {
      // Error bodies aren't consistently JSON in practice (e.g. 401 responses come
      // back as plain text "unauthorized"), so read as text first and only try to
      // pull a JSON .error out of it — falling back to the raw text otherwise.
      const raw = (await response.text().catch(() => "")).trim();
      let message = raw;
      try {
        const parsed = JSON.parse(raw) as MwEmailErrorBody;
        if (parsed.error) message = parsed.error;
      } catch {
        // not JSON — raw text is already the message
      }
      throw new Error(message || `MW Email Service request failed: ${response.status}`);
    }
  }
}

export function createEmailProvider(provider: string, apiKey: string, from: string): EmailProvider {
  if (provider === "resend") return new ResendProvider(apiKey, from);
  if (provider === "mw") return new MwEmailProvider(apiKey, from);
  throw new Error(`Unknown email provider: ${provider}`);
}
