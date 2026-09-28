# 🧠 Janus AI Assistant Integration Guide

Janus is the conversational intelligence and automation brain of Janus. It combines state-of-the-art Large Language Models (LLMs), real-time tool calling, and long-term semantic memory (`pgvector`) to control the estate through natural language.

---

## 🔑 1. Supported Providers

### Primary: Google Gemini (Recommended)
Janus is optimized for **Google Gemini 2.5 Flash** (for ultra-low latency voice turns) and **Gemini 2.5 Pro** (for complex scheduling and reasoning):

1. Obtain an API key from [Google AI Studio](https://aistudio.google.com/).
2. Add the key to your `.env`:
   ```env
   GEMINI_API_KEY=AIzaSy...
   MODEL_DEFAULT=google/gemini-2.5-flash
   MODEL_COMPLEX=google/gemini-2.5-pro
   ```

> [!IMPORTANT]
> The `GEMINI_API_KEY` is also used to generate 768-dimensional vector embeddings via `text-embedding-004` for long-term memory retrieval in PostgreSQL.

### Secondary: OpenRouter
If you prefer routing across Anthropic Claude 3.5 Sonnet, OpenAI GPT-4o, or DeepSeek:
1. Obtain an API key from [OpenRouter](https://openrouter.ai/).
2. Configure your `.env`:
   ```env
   OPENROUTER_API_KEY=sk-or-v1-...
   MODEL_DEFAULT=anthropic/claude-3.5-sonnet
   ```

### Local / Private: Ollama (Zero-Cloud Option)
To run completely offline without sending estate conversations to the cloud:
1. Install [Ollama](https://ollama.ai/) on your local network.
2. Pull a tool-capable model:
   ```bash
   ollama pull qwen2.5:14b-instruct
   ```
3. Set your endpoint in `.env`:
   ```env
   OLLAMA_BASE_URL=http://localhost:11434
   MODEL_DEFAULT=ollama/qwen2.5:14b-instruct
   ```

---

## 🎭 2. Customizing the System Persona (`SOUL.md`)

Janus's conversational tone, boundaries, and estate context are defined in:
```
supabase/functions/_shared/SOUL.md
```

You can customize this file to give Janus the exact personality you prefer:
- Formal butler style (Jarvis / Alfred)
- High-efficiency executive coordinator
- Warm family assistant

---

## 🛠️ 3. How Janus Tool Calling Works

Janus has direct access to over 30 estate tools declared in [`supabase/functions/_shared/janus-tools.ts`](../../supabase/functions/_shared/janus-tools.ts).

### Execution Flow:
1. User speaks: *"Janus, turn on the pool waterfall and dim the patio lights to 30%."*
2. The model outputs structured tool call JSON:
   ```json
   [
     { "name": "set_pool_feature", "arguments": { "feature": "waterfall", "state": true } },
     { "name": "set_light_state", "arguments": { "entity_id": "light.patio", "brightness_pct": 30 } }
   ]
   ```
3. The server executes both commands concurrently via the Home Assistant and Pool API adapters.
4. Results are fed back into the context window, and Janus confirms verbally: *"Waterfall is on, and patio lights have been set to 30%."*

---

## ➕ 4. Adding a Custom Tool

To add your own custom tool (for example, triggering a robot vacuum or coffee machine):

1. **Declare the Tool Schema** in `supabase/functions/_shared/janus-tools.ts`:
   ```ts
   export const startVacuumTool = {
     name: "start_vacuum",
     description: "Start vacuuming a specific room in the house",
     parameters: {
       type: "object",
       properties: {
         room: { type: "string", description: "The room to clean, e.g., 'kitchen', 'dining_room'" }
       },
       required: ["room"]
     }
   };
   ```

2. **Implement the Execution Handler**:
   ```ts
   case "start_vacuum":
     return await homeAssistant.callService("vacuum", "send_command", {
       entity_id: "vacuum.roborock",
       command: "app_zoned_clean",
       params: [args.room]
     });
   ```

Janus will automatically discover the new capability on startup!
