import { log } from "./log.js";

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  log.debug("[solonbot] sendTelegramMessage called:", { chatId, textLength: text.length });

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });

  if (!response.ok) {
    const errorBody = await response.json() as { description?: string };
    const description = errorBody.description ?? "unknown error";
    throw new Error(`Telegram API error ${response.status}: ${description}`);
  }

  log.debug("[solonbot] sendTelegramMessage response status:", response.status);
}
