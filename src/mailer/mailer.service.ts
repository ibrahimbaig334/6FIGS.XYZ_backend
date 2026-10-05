import { Injectable, Logger } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import { Resend } from "resend";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const RESEND_PLACEHOLDER = "re_xxxxxxxxx";

/**
 * Delivery for account email. Prefers the Resend API when a real key is set,
 * falls back to SMTP when configured, and logs to the console in development.
 * Production refuses to boot without a provider unless the explicit console
 * override is set, so recovery links cannot be dropped silently.
 */
@Injectable()
export class MailerService {
  private readonly log = new Logger("MailerService");
  private readonly transport: Transporter | null;
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor() {
    const env = process.env;
    this.from = (env.MAIL_FROM ?? "").trim() || "6figs <onboarding@resend.dev>";

    const resendKey = (env.RESEND_API_KEY ?? "").trim();
    if (this.isRealResendKey(resendKey)) {
      this.resend = new Resend(resendKey);
      this.transport = null;
      return;
    }
    this.resend = null;

    const host = (env.SMTP_HOST ?? "").trim();
    if (!host) {
      this.transport = null;
      if (env.NODE_ENV === "production" && env.SIXFIGS_ALLOW_CONSOLE_MAILER !== "1") {
        throw new Error(
          "No mail provider configured: set RESEND_API_KEY or SMTP_HOST in production; SIXFIGS_ALLOW_CONSOLE_MAILER=1 only for a deliberate console-mailer deployment",
        );
      }
      return;
    }
    const port = Number(env.SMTP_PORT ?? 587);
    const user = (env.SMTP_USER ?? "").trim();
    const pass = env.SMTP_PASS ?? "";
    this.transport = createTransport({
      host,
      port,
      secure: port === 465,
      ...(user ? { auth: { user, pass } } : {}),
    });
  }

  /** The Resend API rejects non-key values; treat the doc placeholder as unset. */
  private isRealResendKey(key: string): boolean {
    return key.length > 0 && key !== RESEND_PLACEHOLDER && /^re_[A-Za-z0-9_]+$/.test(key);
  }

  /** Callers await so delivery failures are observable. */
  async send(message: MailMessage): Promise<void> {
    if (this.resend) {
      const { error } = await this.resend.emails.send({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      if (error) {
        throw new Error(`resend send failed: ${error.message ?? "unknown error"}`);
      }
      return;
    }
    if (this.transport) {
      await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      return;
    }
    this.log.log(
      `[console mailer] to=${message.to} subject=${message.subject}\n${message.text}`,
    );
  }
}