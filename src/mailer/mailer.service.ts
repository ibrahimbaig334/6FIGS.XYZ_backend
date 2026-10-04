import { Injectable, Logger } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Delivery for account email. SMTP when configured; a console transport in
 * development. Production refuses to boot without SMTP unless the operator
 * sets the explicit console override, so recovery links cannot be dropped
 * silently in production.
 */
@Injectable()
export class MailerService {
  private readonly log = new Logger("MailerService");
  private readonly transport: Transporter | null;
  private readonly from: string;

  constructor() {
    const env = process.env;
    const host = (env.SMTP_HOST ?? "").trim();
    this.from = (env.MAIL_FROM ?? "").trim() || "6figs <no-reply@6figs.xyz>";
    if (!host) {
      this.transport = null;
      if (env.NODE_ENV === "production" && env.SIXFIGS_ALLOW_CONSOLE_MAILER !== "1") {
        throw new Error(
          "SMTP_HOST is required in production; set SIXFIGS_ALLOW_CONSOLE_MAILER=1 only for a deliberate console-mailer deployment",
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

  /** Fire-and-forget friendly: callers await so failures are observable. */
  async send(message: MailMessage): Promise<void> {
    if (!this.transport) {
      this.log.log(
        `[console mailer] to=${message.to} subject=${message.subject}\n${message.text}`,
      );
      return;
    }
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  }
}