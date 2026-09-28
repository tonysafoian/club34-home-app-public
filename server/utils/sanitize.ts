export function sanitizeText(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD\u034F\u180E]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\uFE00-\uFE0F]/g, "")
    .replace(/[\uDB40][\uDC01-\uDC7F]/g, "")
    .replace(/\s{20,}/g, " ")
    .replace(/\0/g, "");
}

type ChatRole = "assistant" | "user";

interface SanitizedMessage {
  role: ChatRole;
  content: unknown;
}

export function sanitizeMessages(messages: unknown[]): SanitizedMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((msg): msg is Record<string, unknown> => msg != null && typeof msg === "object")
    .map((msg) => {
      const role: ChatRole = msg.role === "assistant" ? "assistant" : "user";

      if (typeof msg.content === "string") {
        return { role, content: sanitizeText(msg.content) };
      }

      if (Array.isArray(msg.content)) {
        const sanitizedContent = msg.content
          .filter((part): part is Record<string, unknown> => part != null && typeof part === "object")
          .map((part) => {
            if (part.type === "text" && typeof part.text === "string") {
              return { ...part, text: sanitizeText(part.text) };
            }
            if (part.type === "image_url") {
              const imageUrl = part.image_url as { url?: unknown } | undefined;
              if (imageUrl?.url) {
                const url = String(imageUrl.url);
                if (!url.startsWith("data:image/") && !url.startsWith("https://")) {
                  return { type: "text", text: "[invalid media removed]" };
                }
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
