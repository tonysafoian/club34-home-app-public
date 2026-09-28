import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, Mic, X, Paperclip, FileText, Video, Bookmark } from 'lucide-react';
import mammoth from 'mammoth';
import { readXlsxToText } from '@/lib/xlsxUtils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useUserRole } from '@/hooks/useUserRole';
import { useAuth } from '@/hooks/useAuth';
import { resolveApiUrl } from '@/lib/api/fetchWithAuth';
import { apiClient } from '@/lib/apiClient';
import { useAddArtifact, useProjectArtifacts, useUpdateProject } from '@/hooks/useProjects';
import janusIcon from '@/assets/janus-icon.png';
import ReactMarkdown from 'react-markdown';

// ---- Types (same as JanusDrawer) ----
type ContentPart =
  { type: 'text'; text: string } |
  { type: 'image_url'; image_url: { url: string } } |
  { type: 'input_audio'; input_audio: { data: string; format: string } };

type Msg = {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
  voiceAudio?: string;
  _attachments?: Attachment[];
};

interface Attachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'extracted';
  mimeType: string;
  dataUrl: string;
  name: string;
  extractedText?: string;
}

function getTextContent(msg: Msg): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('');
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const CHAT_URL = resolveApiUrl('/janus-chat');

const TOOL_STATUS_MAP: Record<string, string> = {
  web_search: 'Searching the web...', scrape_website: 'Reading page...',
  get_calendar_events: 'Checking your calendar...', create_calendar_event: 'Creating calendar event...',
  get_directions: 'Getting directions...', search_places: 'Finding places...',
  get_environment_data: 'Checking air quality...', search_news: 'Searching news...',
  query_notion_database: 'Checking Notion...', update_notion_page: 'Updating Notion...',
  create_notion_page: 'Creating Notion page...', send_email: 'Sending email...',
  send_whatsapp: 'Sending WhatsApp...', remember_fact: 'Saving to memory...',
  recall_facts: 'Recalling memories...', save_to_cart: 'Adding to cart...',
  view_cart: 'Checking cart...', generate_media: '🎨 Generating media...',
  launch_research: '🔬 Launching research...',
  add_project_note: 'Saving note to project...', get_project_notes: 'Loading project notes...',
};

function parseToolStatus(line: string): string | null {
  const toolMatch = line.match(/tool:(\w+)/);
  if (toolMatch) return TOOL_STATUS_MAP[toolMatch[1]] ?? `Running ${toolMatch[1]}...`;
  const execMatch = line.match(/executing\s+([\w,\s]+)/);
  if (execMatch) {
    const labels = execMatch[1].split(',').map(t => t.trim()).filter(Boolean).map(t => TOOL_STATUS_MAP[t]).filter(Boolean);
    if (labels.length) return labels[0];
  }
  if (line.includes('processing tool round') || line.includes('thinking')) return 'Thinking...';
  return null;
}

async function getAuthToken(): Promise<string> {
  const resp = await fetch('/api/auth/token', { credentials: 'include' });
  if (!resp.ok) return '';
  const data = await resp.json();
  return data?.token || '';
}

interface Props {
  projectId: string;
  projectName: string;
  isFirstMessage: boolean;
  onFirstMessage: () => void;
}

export function ProjectChat({ projectId, projectName, isFirstMessage, onFirstMessage }: Props) {
  // Restore messages from sessionStorage on mount (survives navigation)
  const [messages, setMessages] = useState<Msg[]>(() => {
    try {
      const cached = sessionStorage.getItem(`project-chat-${projectId}`);
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [userDisplayName, setUserDisplayName] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const sendingRef = useRef(false);
  const sendVoiceMessageRef = useRef<((dataUrl: string, format: string) => void) | null>(null);
  const { toast } = useToast();
  const { role } = useUserRole();
  const { user } = useAuth();
  const addArtifact = useAddArtifact();
  const { data: artifacts = [] } = useProjectArtifacts(projectId);
  const updateProject = useUpdateProject();

  // Fetch current user display name
  useEffect(() => {
    if (!user) return;
    apiClient.dbMaybeSingle<{ display_name?: string | null }>({
      table: 'profiles',
      select: 'display_name',
      filters: [{ column: 'user_id', op: 'eq', value: user.userId }],
    }).then(({ data }) => {
      setUserDisplayName(data?.display_name || user.email || null);
    });
  }, [user]);

  // Persist messages to sessionStorage so they survive navigation
  useEffect(() => {
    try {
      // Strip large audio data before caching to keep sessionStorage small
      const toCache = messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content
          : (m.content as ContentPart[]).filter(p => p.type !== 'input_audio'),
      }));
      sessionStorage.setItem(`project-chat-${projectId}`, JSON.stringify(toCache));
    } catch { /* sessionStorage full — ignore */ }
  }, [messages, projectId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // Pre-warm mic
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(s => { streamRef.current = s; })
      .catch(() => {});
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()); };
  }, []);

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) { toast({ title: 'File too large', variant: 'destructive' }); continue; }
      const isDocx = file.name.endsWith('.docx');
      const isXlsx = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');

      if (isDocx) {
        try {
          const ab = await file.arrayBuffer();
          const result = await mammoth.extractRawText({ arrayBuffer: ab });
          if (!result.value.trim()) continue;
          setAttachments(prev => [...prev, { type: 'extracted', mimeType: file.type, dataUrl: '', name: file.name, extractedText: result.value.trim() }]);
        } catch (e) { console.error('ProjectChat message parse error:', e); }
        continue;
      }
      if (isXlsx) {
        try {
          const ab = await file.arrayBuffer();
          const text = await readXlsxToText(ab);
          if (!text) continue;
          setAttachments(prev => [...prev, { type: 'extracted', mimeType: file.type, dataUrl: '', name: file.name, extractedText: text }]);
        } catch (e) { console.error('ProjectChat message parse error:', e); }
        continue;
      }

      const dataUrl = await fileToBase64(file);
      const type = file.type.startsWith('video/') ? 'video' as const :
        file.type.startsWith('audio/') ? 'audio' as const :
        file.type.startsWith('image/') ? 'image' as const : 'document' as const;
      setAttachments(prev => [...prev, { type, mimeType: file.type, dataUrl, name: file.name }]);
    }
  }, [toast]);

  const removeAttachment = useCallback((i: number) => setAttachments(prev => prev.filter((_, idx) => idx !== i)), []);

  const buildContent = useCallback((text: string, atts: Attachment[]): string | ContentPart[] => {
    if (!atts.length) return text;
    const parts: ContentPart[] = [];
    if (text.trim()) parts.push({ type: 'text', text });
    for (const att of atts) {
      if (att.type === 'extracted' && att.extractedText) {
        parts.push({ type: 'text', text: `[${att.name}]\n\n${att.extractedText}` });
      } else if (att.type === 'image' || att.type === 'video' || att.type === 'document') {
        parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
      } else if (att.type === 'audio') {
        const base64 = att.dataUrl.split(',')[1] || att.dataUrl;
        parts.push({ type: 'input_audio', input_audio: { data: base64, format: 'webm' } });
      }
    }
    if (!text.trim() && atts.length) {
      const def = atts.some(a => a.type === 'audio') ? 'Here is a voice message.' : 'What do you see in this?';
      parts.unshift({ type: 'text', text: def });
    }
    return parts;
  }, []);

  const streamAndUpdate = useCallback(async (userMsg: Msg, allMessages: Msg[]) => {
    let assistantSoFar = '';
    const token = await getAuthToken();
    // Strip input_audio blobs from older messages to reduce payload size
    const lastUserIdx = allMessages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1);
    const clean = allMessages.map(({ role, content }, idx) => {
      if (idx < lastUserIdx && Array.isArray(content)) {
        const stripped = content
          .filter((p: ContentPart) => p.type !== 'input_audio')
          .concat(
            content.some((p: ContentPart) => p.type === 'input_audio')
              ? [{ type: 'text' as const, text: '[Voice message]' }]
              : []
          );
        return { role, content: stripped.length === 1 && stripped[0].type === 'text' ? stripped[0].text : stripped };
      }
      return { role, content };
    });

    const resp = await fetch(CHAT_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: clean, userRole: role || 'member', newSession: false, project_id: projectId }),
    });

    if (!resp.ok || !resp.body) {
      setIsLoading(false); sendingRef.current = false;
      toast({ title: 'Error', description: 'Something went wrong.', variant: 'destructive' });
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;

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
          const status = parseToolStatus(line.slice(1).trim());
          if (status) setToolStatus(status);
          continue;
        }
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (json === '[DONE]') { done = true; break; }
        try {
          const parsed = JSON.parse(json);
          if (parsed.image_data && parsed.mime) {
            const dataUrl = `data:${parsed.mime};base64,${parsed.image_data}`;
            setMessages(prev => [...prev, { role: 'assistant', content: `![Generated image](${dataUrl})` }]);
            continue;
          }
          if (parsed.type === 'voice_audio' || parsed.type === 'voice_transcript') continue;
          const c = parsed.choices?.[0]?.delta?.content;
          if (c) {
            setToolStatus(null);
            assistantSoFar += c;
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantSoFar } : m);
              }
              return [...prev, { role: 'assistant', content: assistantSoFar }];
            });
          }
        } catch { buf = line + '\n' + buf; break; }
      }
    }
    setIsLoading(false);
    setToolStatus(null);
    sendingRef.current = false;
  }, [role, toast, projectId]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !attachments.length) || isLoading || sendingRef.current) return;
    sendingRef.current = true;

    const currentAtts = [...attachments];
    setInput(''); setAttachments([]);

    const content = buildContent(text, currentAtts);
    const userMsg: Msg = { role: 'user', content, _attachments: currentAtts.length ? currentAtts : undefined };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true); setToolStatus(null);

    // Auto-name project on first message
    if (isFirstMessage && text) {
      const autoName = text.replace(/[^\w\s]/g, '').trim().slice(0, 50);
      if (autoName) {
        updateProject.mutate({ id: projectId, name: autoName.charAt(0).toUpperCase() + autoName.slice(1) });
        onFirstMessage();
      }
    }

    await streamAndUpdate(userMsg, [...messages, userMsg]);
  }, [input, attachments, isLoading, messages, buildContent, isFirstMessage, projectId, updateProject, onFirstMessage, streamAndUpdate]);

  const saveToProject = useCallback((msg: Msg) => {
    const text = getTextContent(msg);
    const isCode = text.includes('```');
    addArtifact.mutate({
      project_id: projectId,
      artifact_type: isCode ? 'code' : 'text',
      title: text.slice(0, 60).replace(/[#*`]/g, '').trim() || 'Response',
      content: text,
      sort_order: artifacts.length,
      saved_by_user_id: user?.userId,
      saved_by_display_name: userDisplayName || undefined,
    });
    toast({ title: 'Saved to project' });
  }, [projectId, artifacts.length, addArtifact, toast, user, userDisplayName]);

  // Voice recording
  const startWithStream = useCallback((stream: MediaStream) => {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    audioChunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' });
      setIsRecording(false);
      if (blob.size < 500) return;
      const dataUrl = await fileToBase64(new File([blob], 'voice.webm', { type: mimeType || 'audio/webm' }));
      sendVoiceMessageRef.current?.(dataUrl, 'webm');
    };
    mediaRecorderRef.current = recorder;
    recorder.start(250);
    setIsRecording(true);
  }, []);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (stream) startWithStream(stream);
    else navigator.mediaDevices.getUserMedia({ audio: true }).then(startWithStream).catch(() => {});
  }, [startWithStream]);

  const stopRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (rec?.state === 'recording') { rec.requestData(); setTimeout(() => rec.stop(), 200); }
  }, []);

  const sendVoice = useCallback(async (dataUrl: string, format: string) => {
    if (isLoading || sendingRef.current) return;
    sendingRef.current = true;
    const base64 = dataUrl.split(',')[1] || dataUrl;
    const att: Attachment = { type: 'audio', mimeType: `audio/${format}`, dataUrl, name: 'Voice' };
    const content: ContentPart[] = [
      { type: 'text', text: 'Here is a voice message.' },
      { type: 'input_audio', input_audio: { data: base64, format } },
    ];
    const userMsg: Msg = { role: 'user', content, _attachments: [att] };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    await streamAndUpdate(userMsg, [...messages, userMsg]);
  }, [isLoading, messages, streamAndUpdate]);

  useEffect(() => { sendVoiceMessageRef.current = sendVoice; }, [sendVoice]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      imageFiles.forEach(f => dt.items.add(f));
      handleFileSelect(dt.files);
    }
  }, [handleFileSelect]);

  return (
    <div className="flex flex-col h-full">
      {/* Chat header */}
      <div className="flex-shrink-0 bg-primary px-4 py-3">
        <div className="flex items-center gap-3">
          <img src={janusIcon} alt="Janus" className="w-8 h-8 rounded-xl" />
          <div>
            <span className="text-sm font-bold text-primary-foreground">JANUS</span>
            <p className="text-[10px] text-primary-foreground/70">Project: {projectName}</p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <p className="text-sm">Start chatting with Janus. Save any response as a project artifact.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <img src={janusIcon} alt="Janus" className="w-7 h-7 rounded-lg mt-1 flex-shrink-0" />
            )}
            <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm ${
              msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card border border-border'
            }`}>
              {msg.role === 'user' && msg._attachments?.map((att, j) => (
                <div key={j} className="mb-1">
                  {att.type === 'image' && <img src={att.dataUrl} className="rounded-lg max-h-32" alt="" />}
                  {att.type === 'audio' && <div className="text-xs opacity-80 flex items-center gap-1"><Mic className="h-3 w-3" /> Voice</div>}
                  {(att.type === 'document' || att.type === 'extracted') && <div className="text-xs opacity-80 flex items-center gap-1"><FileText className="h-3 w-3" /> {att.name}</div>}
                </div>
              ))}
              {msg.role === 'assistant' ? (
                <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:my-1">
                  <ReactMarkdown
                    components={{
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                      ),
                      img: ({ src, alt }) => (
                        <img src={src} alt={alt || ''} className="rounded-xl max-w-full mt-2 border border-border" onClick={() => src && window.open(src, '_blank')} />
                      ),
                    }}
                  >{getTextContent(msg)}</ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{getTextContent(msg)}</p>
              )}
              {msg.role === 'assistant' && (getTextContent(msg).trim() || getTextContent(msg).includes('![')) && (
                <button
                  onClick={() => saveToProject(msg)}
                  className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors"
                >
                  <Bookmark className="h-3 w-3" /> Save to Project
                </button>
              )}
            </div>
          </div>
        ))}

        {isLoading && messages[messages.length - 1]?.role === 'user' && (
          <div className="flex gap-2.5">
            <img src={janusIcon} alt="Janus" className="w-7 h-7 rounded-lg mt-1 flex-shrink-0" />
            <div className="bg-card border border-border rounded-xl px-3.5 py-3 space-y-1.5">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
              </div>
              {toolStatus && <p className="text-[10px] text-muted-foreground/70 italic">{toolStatus}</p>}
            </div>
          </div>
        )}
      </div>

      {/* Attachment preview */}
      {attachments.length > 0 && (
        <div className="px-4 pb-1 flex gap-2 overflow-x-auto flex-shrink-0">
          {attachments.map((att, i) => (
            <div key={i} className="relative group flex-shrink-0">
              {att.type === 'image' && <img src={att.dataUrl} className="h-12 w-12 rounded-lg object-cover border border-border" alt="" />}
              {att.type === 'video' && <div className="h-12 w-12 rounded-lg border border-border bg-muted flex items-center justify-center"><Video className="h-4 w-4 text-muted-foreground" /></div>}
              {(att.type === 'document' || att.type === 'extracted') && <div className="h-12 w-12 rounded-lg border border-border bg-muted flex items-center justify-center"><FileText className="h-4 w-4 text-muted-foreground" /></div>}
              <button onClick={() => removeAttachment(i)} className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X className="h-2.5 w-2.5" /></button>
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border px-3 py-3 flex-shrink-0">
        <input ref={fileInputRef} type="file" accept="image/*,video/*,.pdf,.txt,.csv,.md,.html,.docx,.xlsx,.xls" multiple className="hidden" onChange={(e) => handleFileSelect(e.target.files)} />
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0 text-muted-foreground" onClick={() => fileInputRef.current?.click()}>
            <Paperclip className="h-5 w-5" />
          </Button>
          <Textarea
            value={isRecording ? '' : input}
            onChange={(e) => !isRecording && setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isRecording ? '🔴 Recording...' : 'Message Janus...'}
            readOnly={isRecording}
            className={`resize-none min-h-[40px] max-h-28 text-sm rounded-full px-4 py-2.5 ${isRecording ? 'border-destructive/50' : ''}`}
            rows={1}
          />
          {input.trim() || attachments.length > 0 ? (
            <Button onClick={send} disabled={isLoading} size="icon" className="flex-shrink-0 h-9 w-9 rounded-full">
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          ) : (
            <Button
              variant={isRecording ? 'destructive' : 'ghost'}
              size="icon"
              className={`flex-shrink-0 h-9 w-9 rounded-full ${isRecording ? 'animate-pulse' : 'text-primary'}`}
              onPointerDown={startRecording}
              onPointerUp={stopRecording}
              onPointerLeave={isRecording ? stopRecording : undefined}
            >
              <Mic className="h-5 w-5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
