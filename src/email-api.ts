import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { EmailConfig } from "./config.js";
import { log } from "./log.js";

let transporter: Transporter | undefined;
let configuredFromAddress: string | undefined;

export function initializeEmailTransport(config: EmailConfig): void {
  log.info("[solonbot] Initializing email transport:", config.smtpHost, config.smtpPort);
  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPassword,
    },
  });
  configuredFromAddress = config.fromAddress;
}

export interface EmailAttachment {
  filename: string;
  path: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  attachments?: EmailAttachment[],
): Promise<void> {
  if (transporter === undefined || configuredFromAddress === undefined) {
    throw new Error("Email transport is not initialized. Call initializeEmailTransport first.");
  }

  await transporter.sendMail({
    from: configuredFromAddress,
    to,
    subject,
    text: body,
    attachments: attachments?.map((attachment) => ({
      filename: attachment.filename,
      path: attachment.path,
    })),
  });
}
