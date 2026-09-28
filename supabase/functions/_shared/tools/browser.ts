// Browser automation via Browserbase Stagehand REST API
// Gives Janus the ability to interact with websites — click, type, navigate, extract data

const STAGEHAND_BASE = "https://api.stagehand.dev";

interface BrowseStep {
  action: "navigate" | "act" | "extract";
  value: string;
}

function getHeaders(): Record<string, string> {
  const apiKey = Deno.env.get("BROWSERBASE_API_KEY");
  const projectId = Deno.env.get("BROWSERBASE_PROJECT_ID");
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY not configured");
  if (!projectId) throw new Error("BROWSERBASE_PROJECT_ID not configured");
  return {
    "Content-Type": "application/json",
    "x-bb-api-key": apiKey,
    "x-bb-project-id": projectId,
  };
}

type StagehandResponse = {
  data?: { session_id?: string; [key: string]: unknown };
  session_id?: string;
  id?: string;
  [key: string]: unknown;
};

async function stagehandPost(path: string, body: Record<string, unknown>): Promise<StagehandResponse> {
  const headers = getHeaders();
  const res = await fetch(`${STAGEHAND_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Stagehand ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

async function closeSession(sessionId: string): Promise<void> {
  try {
    const headers = getHeaders();
    await fetch(`${STAGEHAND_BASE}/sessions/${sessionId}/close`, {
      method: "POST",
      headers,
      body: "{}",
    });
  } catch {
    // best-effort cleanup
  }
}

export async function executeBrowseWebsite(
  url: string,
  instruction: string,
  steps?: BrowseStep[],
): Promise<string> {
  const bbApiKey = Deno.env.get("BROWSERBASE_API_KEY");
  const bbProjectId = Deno.env.get("BROWSERBASE_PROJECT_ID");
  if (!bbApiKey) return "TOOL_ERROR: BROWSERBASE_API_KEY not configured. Add it in Supabase Dashboard → Edge Functions → Secrets.";
  if (!bbProjectId) return "TOOL_ERROR: BROWSERBASE_PROJECT_ID not configured. Add it in Supabase Dashboard → Edge Functions → Secrets.";

  const modelApiKey = Deno.env.get("GOOGLE_GENERATIVE_AI_API_KEY") || Deno.env.get("GEMINI_API_KEY");
  if (!modelApiKey) return "TOOL_ERROR: GOOGLE_GENERATIVE_AI_API_KEY not configured for browser AI model.";

  let sessionId: string | undefined;

  try {
    const session = await stagehandPost("/sessions/start", {
      model_name: "google/gemini-2.5-flash",
      model_api_key: modelApiKey,
    });
    sessionId = session.data?.session_id || session.session_id || session.id;
    if (!sessionId) {
      return `TOOL_ERROR: Failed to start browser session: ${JSON.stringify(session).slice(0, 300)}`;
    }
    console.log(`Browser session started: ${sessionId}`);

    let formattedUrl = url.trim();
    if (!formattedUrl.startsWith("http://") && !formattedUrl.startsWith("https://")) {
      formattedUrl = `https://${formattedUrl}`;
    }
    await stagehandPost(`/sessions/${sessionId}/navigate`, { url: formattedUrl });
    console.log(`Navigated to: ${formattedUrl}`);

    const results: string[] = [];

    if (steps && steps.length > 0) {
      for (const step of steps) {
        try {
          switch (step.action) {
            case "navigate": {
              let stepUrl = step.value.trim();
              if (!stepUrl.startsWith("http://") && !stepUrl.startsWith("https://")) {
                stepUrl = `https://${stepUrl}`;
              }
              await stagehandPost(`/sessions/${sessionId}/navigate`, { url: stepUrl });
              results.push(`Navigated to: ${stepUrl}`);
              break;
            }
            case "act": {
              const actResult = await stagehandPost(`/sessions/${sessionId}/act`, {
                input: step.value,
              });
              results.push(`Action "${step.value}": ${JSON.stringify(actResult.data || actResult).slice(0, 500)}`);
              break;
            }
            case "extract": {
              const extractResult = await stagehandPost(`/sessions/${sessionId}/extract`, {
                instruction: step.value,
              });
              results.push(`Extracted: ${JSON.stringify(extractResult.data || extractResult).slice(0, 2000)}`);
              break;
            }
          }
        } catch (stepErr) {
          results.push(`Step "${step.action}: ${step.value}" failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
        }
      }
    } else {
      if (instruction) {
        try {
          const actResult = await stagehandPost(`/sessions/${sessionId}/act`, {
            input: instruction,
          });
          results.push(`Action: ${JSON.stringify(actResult.data || actResult).slice(0, 500)}`);
        } catch (actErr) {
          results.push(`Action failed: ${actErr instanceof Error ? actErr.message : String(actErr)}`);
        }
      }

      try {
        const extractResult = await stagehandPost(`/sessions/${sessionId}/extract`, {
          instruction: instruction || "Extract the main content, key information, prices, availability, and any relevant data from this page.",
        });
        results.push(`Extracted: ${JSON.stringify(extractResult.data || extractResult).slice(0, 4000)}`);
      } catch (extractErr) {
        results.push(`Extract failed: ${extractErr instanceof Error ? extractErr.message : String(extractErr)}`);
      }
    }

    await closeSession(sessionId);

    const output = {
      url: formattedUrl,
      session_id: sessionId,
      session_replay: `https://browserbase.com/sessions/${sessionId}`,
      results,
    };

    const outputStr = JSON.stringify(output);
    return outputStr.length > 8000 ? outputStr.slice(0, 8000) + "\n...(truncated)" : outputStr;
  } catch (e) {
    if (sessionId) {
      await closeSession(sessionId);
    }
    const errMsg = e instanceof Error ? e.message : String(e);
    const replayLink = sessionId ? ` Session replay: https://browserbase.com/sessions/${sessionId}` : "";
    return `TOOL_ERROR: Browser session failed: ${errMsg}${replayLink}`;
  }
}
