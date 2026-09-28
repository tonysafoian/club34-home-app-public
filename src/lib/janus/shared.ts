import { resolveApiUrl } from '@/lib/api/fetchWithAuth';

// ── Types ──────────────────────────────────────────────────────────────
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export type Msg = {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
  voiceAudio?: string;
  _error?: boolean;
  _voiceTranscript?: string;
  _attachments?: {
    type: 'image' | 'video' | 'audio' | 'document' | 'extracted';
    mimeType?: string;
    dataUrl: string;
    name?: string;
    extractedText?: string;
  }[];
};

export type ToolStep = { label: string; done: boolean };

export const TOOL_STATUS_MAP: Record<string, string> = {
  web_search: 'Searching the web\u2026',
  scrape_website: 'Reading page\u2026',
  get_calendar_events: 'Checking calendar\u2026',
  create_calendar_event: 'Creating event\u2026',
  delete_calendar_event: 'Deleting event\u2026',
  check_availability: 'Checking availability\u2026',
  get_directions: 'Getting directions\u2026',
  search_places: 'Finding places\u2026',
  get_environment_data: 'Checking environment\u2026',
  search_news: 'Searching news\u2026',
  query_notion_database: 'Checking Notion\u2026',
  update_notion_page: 'Updating Notion\u2026',
  batch_update_notion_pages: 'Batch updating Notion\u2026',
  create_notion_page: 'Creating page\u2026',
  get_notion_database: 'Fetching Notion schema\u2026',
  attach_file_to_notion: 'Attaching file\u2026',
  send_email: 'Sending email\u2026',
  send_whatsapp: 'Sending WhatsApp\u2026',
  remember_fact: 'Saving to memory\u2026',
  recall_facts: 'Recalling memories\u2026',
  save_to_cart: 'Adding to cart\u2026',
  view_cart: 'Checking cart\u2026',
  clear_cart: 'Clearing cart\u2026',
  ha_get_states: 'Checking home systems\u2026',
  ha_get_state: 'Checking device\u2026',
  ha_call_service: 'Controlling device\u2026',
  ha_get_logbook: 'Reading home log\u2026',
  set_reminder: 'Setting reminder\u2026',
  manage_trip: 'Managing trip\u2026',
  query_trips: 'Checking trips\u2026',
  query_entertainment: 'Checking events\u2026',
  query_media: 'Browsing media\u2026',
  suggest_movie: 'Getting recommendations\u2026',
  create_google_file: 'Creating Google file\u2026',
  check_tesla_status: 'Checking Tesla\u2026',
  check_verkada_security: 'Checking security cameras\u2026',
  check_generator_status: 'Checking generator\u2026',
  query_activity_log: 'Checking activity log\u2026',
  query_system_health: 'Checking system health\u2026',
  query_system_updates: 'Checking updates\u2026',
  gmail_search: 'Searching Gmail\u2026',
  generate_media: '\u{1f3a8} Generating media\u2026',
  launch_research: '\u{1f52c} Launching research\u2026',
  add_project_note: 'Saving note to project\u2026',
  get_project_notes: 'Loading project notes\u2026',
};

export function parseToolStatus(
  commentLine: string,
): { type: 'step_start' | 'step_done' | 'status'; label: string } | null {
  const stepStartMatch = commentLine.match(/^step_start:(.+)/);
  if (stepStartMatch) return { type: 'step_start', label: stepStartMatch[1].trim() };
  const stepDoneMatch = commentLine.match(/^step_done:(.+)/);
  if (stepDoneMatch) return { type: 'step_done', label: stepDoneMatch[1].trim() };

  const toolMatch = commentLine.match(/tool:(\w+)/);
  if (toolMatch)
    return { type: 'status', label: TOOL_STATUS_MAP[toolMatch[1]] ?? `Running ${toolMatch[1]}\u2026` };
  const execMatch = commentLine.match(/executing\s+([\w,\s]+)/);
  if (execMatch) {
    const labels = execMatch[1]
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => TOOL_STATUS_MAP[t])
      .filter(Boolean);
    if (labels.length) return { type: 'status', label: labels[0] };
  }
  if (commentLine.includes('processing tool round') || commentLine.includes('thinking'))
    return { type: 'status', label: 'Thinking\u2026' };
  return null;
}

// Map an error status/detail to a user-facing message.
export function janusErrorMessage(status: number, detail?: string): string {
  return status === 429 ? 'Rate limited — please try again shortly.'
    : status === 402 ? 'AI credits exhausted.'
    : status === 401 ? 'Session expired — please refresh.'
    : status === 503 ? 'AI service temporarily unavailable.'
    : detail || 'Something went wrong. Please try again.';
}

// 5xx errors keep a toast; 4xx user-facing errors rely on the inline message.
export function shouldToastJanusError(status: number): boolean {
  return status >= 500;
}

export function getTextContent(msg: Msg): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

// ── Auth ────────────────────────────────────────────────────────────────

export const CHAT_URL = resolveApiUrl('/functions/v1/janus-chat');

export async function getAuthToken(): Promise<string> {
  return '__cookie_auth__';
}

export async function streamChat({
  messages,
  userRole,
  newSession,
  complexity,
  signal,
  onDelta,
  onDone,
  onError,
  onVoiceAudio,
  onVoiceTranscript,
  onStatus,
  onStepStart,
  onStepDone,
  onImageData,
  onUrlCorrections,
}: {
  messages: Msg[];
  userRole: string;
  newSession?: boolean;
  complexity?: 'simple' | 'standard' | 'complex';
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (status: number, detail?: string) => void;
  onVoiceAudio?: (audio: string) => void;
  onVoiceTranscript?: (transcript: string) => void;
  onStatus?: (status: string | null) => void;
  onStepStart?: (label: string) => void;
  onStepDone?: (label: string) => void;
  onImageData?: (dataUrl: string) => void;
  onUrlCorrections?: (correctedText: string, deadUrls: string[]) => void;
}) {
  const cleanMessages = messages.map(({ role, content }) => ({ role, content }));

  const body: Record<string, unknown> = {
    messages: cleanMessages,
    userRole,
    newSession: newSession ?? false,
  };
  if (complexity) body.complexity = complexity;

  const resp = await fetch(CHAT_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok || !resp.body) {
    let detail: string | undefined;
    try {
      const errBody = await resp.clone().json().catch(() => null);
      detail = errBody?.error || errBody?.message;
    } catch { /* ignore */ }
    onError(resp.status, detail);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = false;

  try {
    while (!done) {
      const { done: rDone, value } = await reader.read();
      if (rDone) break;
      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.startsWith(':')) {
          const comment = line.slice(1).trim();
          if (comment) {
            const parsed = parseToolStatus(comment);
            if (parsed) {
              if (parsed.type === 'step_start') {
                onStepStart?.(parsed.label);
              } else if (parsed.type === 'step_done') {
                onStepDone?.(parsed.label);
              } else {
                onStatus?.(parsed.label);
              }
            }
          }
          continue;
        }
        if (line.trim() === '') continue;
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (json === '[DONE]') {
          done = true;
          break;
        }
        try {
          const parsed = JSON.parse(json);
          if (parsed.type === 'voice_audio') {
            onVoiceAudio?.(parsed.audio);
            continue;
          }
          if (parsed.type === 'voice_transcript') {
            onVoiceTranscript?.(parsed.transcript);
            continue;
          }
          if (parsed.type === 'url_corrections') {
            onUrlCorrections?.(parsed.corrected_text, parsed.dead_urls || []);
            continue;
          }
          if (parsed.image_data && parsed.mime) {
            onImageData?.(`data:${parsed.mime};base64,${parsed.image_data}`);
            continue;
          }
          const c = parsed.choices?.[0]?.delta?.content;
          if (c) {
            onStatus?.(null);
            onDelta(c);
          }
        } catch {
          buf = line + '\n' + buf;
          break;
        }
      }
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return;
    }
    throw e;
  }
  onDone();
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function convertToWav(blob: Blob): Promise<Blob> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx({
    sampleRate: 16000,
  });
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const pcm = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const numSamples = pcm.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  } finally {
    await audioCtx.close();
  }
}
