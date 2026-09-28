# 🧠 AI & LLM Provider Setup Guide (Janus Engine)

Janus is powered by an autonomous, voice-capable AI assistant named **Janus**. Unlike cloud-only smart speakers (Alexa, Google Nest), Janus runs on your own hardware, retains long-term semantic memory in PostgreSQL (`pgvector`), and has access to over 30 physical estate tools.

> [!NOTE]
> Janus connects directly to standard public LLM endpoints or local Ollama instances. **To enable Janus, simply configure your preferred model API key.** You can get started completely for **FREE** using Google Gemini.

---

## ⚡ Quickstart: The Minimum Viable Setup (1 Key)

You only need **ONE** API key to unlock the full conversational and memory capabilities of Janus:

### Recommended: Google Gemini (Free Tier Available)
1. Go to **[Google AI Studio](https://aistudio.google.com/)**.
2. Sign in with your Google account and click **Get API key**.
3. Create a free API key.
4. Add it to your `.env`:
   ```env
   GEMINI_API_KEY=AIzaSy...
   MODEL_DEFAULT=google/gemini-2.5-flash
   MODEL_COMPLEX=google/gemini-2.5-pro
   ```

### Why Gemini?
* **Cost**: Google AI Studio provides generous free tier rate limits (15 requests/minute, 1,500 requests/day).
* **Speed**: `gemini-2.5-flash` delivers sub-second voice responses for snappy conversational turns.
* **Memory**: Janus uses Google's `text-embedding-004` to generate vector embeddings stored in PostgreSQL, allowing Janus to remember past preferences, estate notes, and visitor logs forever.

---

## 🌐 Option 2: OpenRouter (Multi-Model Flexibility)

If you prefer using **Anthropic Claude 3.5 Sonnet**, **OpenAI GPT-4o**, or open-source models like **DeepSeek V3**:

1. Create an account at **[OpenRouter.ai](https://openrouter.ai/)**.
2. Generate an API Key under **Keys**.
3. Configure your `.env`:
   ```env
   OPENROUTER_API_KEY=sk-or-v1-...
   MODEL_DEFAULT=anthropic/claude-3.5-sonnet
   MODEL_COMPLEX=anthropic/claude-3.5-sonnet
   ```

OpenRouter lets you hot-swap between world-class models without changing any code or managing separate vendor billing accounts.

---

## 🔒 Option 3: Ollama (100% Local, Zero-Cloud, Zero-Cost)

For users who refuse to send household conversations, family schedules, or camera data to any cloud provider:

1. Install [Ollama](https://ollama.ai/) on your local network (e.g. Mac Studio, homelab Linux server with GPU, or PC).
2. Download a function-calling model:
   ```bash
   ollama pull qwen2.5:14b-instruct
   ```
3. Set your local Ollama endpoint in `.env`:
   ```env
   OLLAMA_BASE_URL=http://localhost:11434
   MODEL_DEFAULT=ollama/qwen2.5:14b-instruct
   ```
4. All prompt assembly, tool calling, and conversations remain 100% within your local LAN.

---

## 🛠️ Specialized AI Workers (Optional Power-Ups)

Janus includes specialized worker pipelines that you can optionally activate by adding their respective keys:

| Service | Environment Variable | Where to Get It | What It Unlocks |
| :--- | :--- | :--- | :--- |
| **Perplexity AI** | `PERPLEXITY_API_KEY` | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) | **Live Web Research**: Janus can search the live web for contractor ratings, local utility outage updates, and weather forecasts. |
| **ElevenLabs** | `ELEVENLABS_API_KEY` | [elevenlabs.io](https://elevenlabs.io/) | **Hyper-Realistic Voice Announcements**: Broadcasts spoken alerts over Sonos or HomePod speakers with lifelike voice synthesis. |
| **Firecrawl** | `FIRECRAWL_API_KEY` | [firecrawl.dev](https://www.firecrawl.dev/) | **Estate Document Ingestion**: Scrapes and cleans web pages, equipment manuals, and utility bills into clean markdown for Janus memory. |
| **Fal.ai** | `FAL_API_KEY` | [fal.ai](https://fal.ai/) | **Image Generation**: Generates architectural visualizations and custom graphics. |
| **Google Maps** | `GOOGLE_MAPS_API_KEY` | [console.cloud.google.com](https://console.cloud.google.com/) | **Commute & Geocoding**: Calculates driving times, traffic congestion, and local estate coordinates. |

---

## 🧪 Testing Your AI Configuration

Once configured, verify that Janus is online:

```bash
# Test Janus API health
curl -s http://localhost:5000/api/janus/health | jq .
```

Or open **[http://localhost:5000/janus](http://localhost:5000/janus)** in your browser and ask:
> *"Janus, introduce yourself and tell me what estate systems are currently connected."*
