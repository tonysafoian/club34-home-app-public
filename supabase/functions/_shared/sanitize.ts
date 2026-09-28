export function sanitizeText(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD\u180E]|\u034F/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\uFE00-\uFE0F]/g, "")
    .replace(/[\uDB40][\uDC01-\uDC7F]/g, "")
    .replace(/\s{20,}/g, " ")
    .replace(/\0/g, "");
}

type IncomingMessagePart = {
  type?: string;
  text?: string;
  image_url?: { url?: unknown };
  [key: string]: unknown;
};
type IncomingMessage = { role?: unknown; content?: unknown };
type SanitizedMessage = { role: string; content: unknown };

export function sanitizeMessages(messages: IncomingMessage[]): SanitizedMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((msg) => msg != null && typeof msg === "object").map((msg) => {
    const role = msg.role === "assistant" ? "assistant" : "user";

    if (typeof msg.content === "string") {
      return { role, content: sanitizeText(msg.content) };
    }

    if (Array.isArray(msg.content)) {
      const sanitizedContent = (msg.content as IncomingMessagePart[])
        .filter((part) => part != null && typeof part === "object")
        .map((part) => {
          if (part.type === "text" && typeof part.text === "string") {
            return { ...part, text: sanitizeText(part.text) };
          }
          if (part.type === "image_url" && part.image_url?.url) {
            const url = String(part.image_url.url);
            if (!url.startsWith("data:image/") && !url.startsWith("https://")) {
              return { type: "text", text: "[invalid media removed]" };
            }
            return part;
          }
          if (part.type === "input_audio") {
            return part;
          }
          return part;
        });
      return { role, content: sanitizedContent };
    }

    return { role, content: msg.content };
  });
}
