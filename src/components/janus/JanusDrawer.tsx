import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Loader2, Trash2, Mic, MicOff, X, Paperclip, Video, FileText, Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useUserRole } from '@/hooks/useUserRole';
import { useAuth } from '@/hooks/useAuth';
import { useRealtimeSocket } from '@/hooks/useRealtimeSocket';
import janusIcon from '@/assets/janus-icon.png';
import ReactMarkdown from 'react-markdown';

import {
  type Msg,
  type ContentPart,
  type ToolStep,
  TOOL_STATUS_MAP,
  parseToolStatus,
  getTextContent,
  getAuthToken,
  streamChat,
  fileToBase64,
  convertToWav,
  janusErrorMessage,
  shouldToastJanusError,
  CHAT_URL,
} from '@/lib/janus/shared';

const isDev = import.meta.env.DEV;
const log = isDev ? console.log.bind(console) : () => {};
const warn = isDev ? console.warn.bind(console) : () => {};

// --- Suggestion chip generator ---
function getSuggestions(response: string): string[] {
  const lower = response.toLowerCase();
  const suggestions: string[] = [];

  if (lower.includes('calendar') || lower.includes('meeting') || lower.includes('event') || lower.includes('schedule')) {
    suggestions.push("What's tomorrow look like?", "Any conflicts this week?");
  }
  if (lower.includes('notion') || lower.includes('task') || lower.includes('project') || lower.includes('overdue')) {
    suggestions.push("Show all overdue tasks", "What's high priority?");
  }
  if (lower.includes('weather') || lower.includes('temperature') || lower.includes('aqi') || lower.includes('pollen')) {
    suggestions.push("Will it rain this week?", "Open weather page");
  }
  if (lower.includes('light') || lower.includes('scene') || lower.includes('thermostat') || lower.includes('climate')) {
    suggestions.push("Set temperature to 72°");
  }
  if (lower.includes('tesla') || lower.includes('charging') || lower.includes('battery') || lower.includes('vehicle')) {
    suggestions.push("Where are the cars?", "Check charge status");
  }
  if (lower.includes('pool') || lower.includes('spa') || lower.includes('heater')) {
    suggestions.push("Turn on the spa", "What's the pool temp?");
  }
  if (lower.includes('cart') || lower.includes('added to cart') || lower.includes('shopping')) {
    suggestions.push("View my cart", "Clear cart");
  }
  if (lower.includes('found') || lower.includes('search') || lower.includes('results') || lower.includes('here are')) {
    suggestions.push("Research this deeper", "Save to cart");
  }
  if (lower.includes('trip') || lower.includes('flight') || lower.includes('hotel') || lower.includes('travel')) {
    suggestions.push("Show upcoming trips", "Any travel this month?");
  }

  return [...new Set(suggestions)].slice(0, 3);
}

// --- Complexity classifier for smart model selection ---
function classifyComplexity(text: string, attachments: Attachment[]): 'simple' | 'standard' | 'complex' {
  const lower = text.toLowerCase().trim();
  const wordCount = text.split(/\s+/).length;

  if (attachments.length > 0) return 'complex';
  if (wordCount > 50) return 'complex';
  if (/\b(research|analyze|compare|investigate|deep dive|comprehensive|detailed|summarize this|write me a)\b/i.test(lower)) return 'complex';

  if (wordCount <= 5) {
    if (/^(hi|hey|hello|sup|yo|good\s*(morning|afternoon|evening|night)|gm|thanks|thank you|ok|bye)\b/i.test(lower)) return 'simple';
    if (/\b(weather|temperature|time|lights?\s*(on|off)|turn\s*(on|off))\b/i.test(lower)) return 'simple';
  }
  if (wordCount <= 10 && /\b(what('s| is) (the )?(weather|time|temperature|aqi))\b/i.test(lower)) return 'simple';

  return 'standard';
}

// App sections for universal search/navigation
const APP_SECTIONS = [
  { name: 'Dashboard / Productivity', path: '/', keywords: ['home', 'dashboard', 'productivity', 'tasks', 'calendar', 'today'] },
  { name: 'Security & Cameras', path: '/security', keywords: ['security', 'cameras', 'verkada', 'motion', 'activity', 'surveillance'] },
  { name: 'Tesla Vehicles', path: '/teslas', keywords: ['tesla', 'car', 'vehicle', 'charge', 'battery', 'drive'] },
  { name: 'Family', path: '/family', keywords: ['family', 'kids', 'children', 'automations', 'brief'] },
  { name: 'Notion', path: '/notion', keywords: ['notion', 'notes', 'databases', 'pages', 'sync'] },
  { name: 'Automations', path: '/automations', keywords: ['automation', 'scrape', 'search', 'bot'] },
  { name: 'Amazon Orders', path: '/common-tasks/amazon', keywords: ['amazon', 'order', 'shopping', 'buy', 'purchase'] },
  { name: 'Settings', path: '/settings', keywords: ['settings', 'config', 'configuration', 'account', 'google', 'home assistant'] },
  { name: 'Activity Log', path: '/activity', keywords: ['activity', 'log', 'events', 'history'] },
  { name: 'User Management', path: '/admin/users', keywords: ['users', 'admin', 'manage', 'roles', 'invite'] },
];

function findMatchingSections(query: string): typeof APP_SECTIONS {
  const lower = query.toLowerCase();
  return APP_SECTIONS.filter((s) =>
    s.keywords.some((k) => lower.includes(k)) || s.name.toLowerCase().includes(lower)
  );
}

interface Attachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'extracted';
  mimeType: string;
  dataUrl: string;
  name: string;
  extractedText?: string;
}

export function JanusDrawer() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [toolSteps, setToolSteps] = useState<ToolStep[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [isNewSession, setIsNewSession] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const doneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { role } = useUserRole();
  const socketHook = useRealtimeSocket();

  const { user: authUser } = useAuth();
  useEffect(() => {
    setUserId(authUser?.userId ?? null);
  }, [authUser]);

  useEffect(() => {
    if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current);
    return () => { if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current); };
  }, []);

  // Subscribe to janus_notifications via WebSocket — append messages when media is ready
  useEffect(() => {
    if (!userId) return;
    const { on } = socketHook;
    return on('janus:notification', (data: unknown) => {
      const notif = data as { message: string; type: string; userId: string };
      if (notif.userId && notif.userId !== userId) return;
      const notifMsg: Msg = { role: 'assistant', content: notif.message };
      setMessages(prev => [...prev, notifMsg]);
      if (!open) {
        toast({ title: '✨ Janus', description: notif.message.slice(0, 80) });
      }
    });
  }, [userId, open, toast, socketHook]);

  // Release mic stream when drawer closes
  useEffect(() => {
    if (!open && streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (!open) {
      abortRef.current?.abort();
    }
  }, [open]);

  // Load conversation history when drawer opens
  useEffect(() => {
    if (!open || historyLoaded) return;
    (async () => {
      try {
        const token = await getAuthToken();
        const resp = await fetch(CHAT_URL, {
          method: 'GET',
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.history?.length) {
            const restored: Msg[] = data.history.map((h: { role: string; content: string }) => ({
              role: h.role as 'user' | 'assistant',
              content: h.content,
            }));
            setMessages(restored);
          }
        }
      } catch (e) {
        console.error('Failed to load chat history:', e);
      }
      setHistoryLoaded(true);
    })();
  }, [open, historyLoaded]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const navigateTo = useCallback((path: string) => {
    setOpen(false);
    navigate(path);
  }, [navigate]);

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        toast({ title: 'File too large', description: 'Max 20MB per file', variant: 'destructive' });
        continue;
      }

      const isDocx = file.name.endsWith('.docx') ||
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const isXlsx = file.name.endsWith('.xlsx') || file.name.endsWith('.xls') ||
        file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.type === 'application/vnd.ms-excel';

      if (isDocx) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const mammoth = await import('mammoth');
          const result = await mammoth.extractRawText({ arrayBuffer });
          const extractedText = result.value.trim();
          if (!extractedText) {
            toast({ title: 'Empty document', description: `${file.name} appears to have no readable text.`, variant: 'destructive' });
            continue;
          }
          setAttachments((prev) => [...prev, {
            type: 'extracted', mimeType: file.type, dataUrl: '', name: file.name, extractedText,
          }]);
        } catch (e) {
          console.error('Janus drawer error:', e);
          toast({ title: 'Could not read Word file', description: `Failed to extract text from ${file.name}.`, variant: 'destructive' });
        }
        continue;
      }

      if (isXlsx) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const { readXlsxToText } = await import('@/lib/xlsxUtils');
          const extractedText = await readXlsxToText(arrayBuffer);
          if (!extractedText) {
            toast({ title: 'Empty spreadsheet', description: `${file.name} appears to have no data.`, variant: 'destructive' });
            continue;
          }
          setAttachments((prev) => [...prev, {
            type: 'extracted', mimeType: file.type, dataUrl: '', name: file.name, extractedText,
          }]);
        } catch (e) {
          console.error('Janus drawer error:', e);
          toast({ title: 'Could not read Excel file', description: `Failed to extract data from ${file.name}.`, variant: 'destructive' });
        }
        continue;
      }

      const dataUrl = await fileToBase64(file);
      const type = file.type.startsWith('video/') ? 'video' as const :
        file.type.startsWith('audio/') ? 'audio' as const :
        file.type.startsWith('image/') ? 'image' as const :
        'document' as const;
      setAttachments((prev) => [...prev, { type, mimeType: file.type, dataUrl, name: file.name }]);
    }
  }, [toast]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Forward ref so startWithStream can call sendVoiceMessage without circular dep
  const sendVoiceMessageRef = useRef<((dataUrl: string, format: string) => void) | null>(null);

  const startWithStream = useCallback((stream: MediaStream) => {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    audioChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunksRef.current.push(e.data);
        log(`[Voice] chunk ${audioChunksRef.current.length}: ${e.data.size} bytes`);
      }
    };
    recorder.onstop = async () => {
      const finalMime = mimeType || 'audio/webm';
      const blob = new Blob(audioChunksRef.current, { type: finalMime });
      log(`[Voice] Recording stopped: ${blob.size} bytes, ${audioChunksRef.current.length} chunks, mime=${finalMime}`);
      setIsRecording(false);
      if (blob.size < 2000) { warn('[Voice] Discarding tiny blob (<2KB)'); return; }
      let finalBlob = blob;
      let format = finalMime.includes('mp4') ? 'mp4' : 'webm';
      try {
        finalBlob = await convertToWav(blob);
        format = 'wav';
        log('[Voice] Converted to WAV:', finalBlob.size, 'bytes');
      } catch (e) {
        warn('[Voice] WAV conversion failed, sending raw audio:', e);
      }
      const dataUrl = await fileToBase64(
        new File([finalBlob], `voice.${format}`, { type: format === 'wav' ? 'audio/wav' : finalMime })
      );
      sendVoiceMessageRef.current?.(dataUrl, format);
    };
    mediaRecorderRef.current = recorder;
    // No timeslice — record as single chunk for clean webm container
    recorder.start();
    recordingStartTimeRef.current = Date.now();
    setIsRecording(true);
    log('[Voice] MediaRecorder started (no timeslice)');
  }, []);

  const startRecording = useCallback(() => {
    // Always request a fresh stream to avoid stale/silent tracks
    const existing = streamRef.current;
    if (existing) {
      existing.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        log('[Voice] Fresh stream obtained, tracks:', stream.getAudioTracks().map(t => `${t.label} state=${t.readyState}`));
        streamRef.current = stream;
        // 300ms warm-up delay so mic hardware actually starts producing audio
        setTimeout(() => {
          startWithStream(stream);
        }, 300);
      })
      .catch(() => toast({ title: 'Microphone Access', description: 'Please allow microphone access to use voice input.', variant: 'destructive' }));
  }, [startWithStream, toast]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording') {
      const elapsed = Date.now() - recordingStartTimeRef.current;
      const MIN_RECORDING_MS = 1500;
      if (elapsed < MIN_RECORDING_MS) {
        // Wait until minimum duration, then stop cleanly
        setTimeout(() => {
          if (recorder.state === 'recording') {
            recorder.stop();
          }
        }, MIN_RECORDING_MS - elapsed);
        return;
      }
      // Just stop — no requestData() needed since we're not using timeslice
      recorder.stop();
    }
  }, []);

  const buildMessageContent = useCallback((text: string, atts: Attachment[]): string | ContentPart[] => {
    if (atts.length === 0) return text;

    const parts: ContentPart[] = [];
    if (text.trim()) parts.push({ type: 'text', text });

    for (const att of atts) {
      if (att.type === 'extracted' && att.extractedText) {
        const ext = att.name.split('.').pop()?.toUpperCase() ?? 'FILE';
        parts.push({ type: 'text', text: `[${ext} document: "${att.name}"]\n\n${att.extractedText}` });
      } else if (att.type === 'image' || att.type === 'video' || att.type === 'document') {
        parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
      } else if (att.type === 'audio') {
        const base64 = att.dataUrl.split(',')[1] || att.dataUrl;
        parts.push({ type: 'input_audio', input_audio: { data: base64, format: 'webm' } });
      }
    }

    if (!text.trim() && atts.length > 0) {
      const hasAudio = atts.some((a) => a.type === 'audio');
      const hasDoc = atts.some((a) => a.type === 'document' || a.type === 'extracted');
      const hasVisual = atts.some((a) => a.type === 'image' || a.type === 'video');
      const defaultText = hasAudio && hasVisual ?
        'Here is an audio message and image. Please listen and analyze both.' :
        hasAudio ?
        'Here is a voice message. Please listen and respond.' :
        hasDoc ?
        'Please read and summarize this document.' :
        'What do you see in this?';
      parts.unshift({ type: 'text', text: defaultText });
    }

    return parts;
  }, []);

  const sendingRef = useRef(false);

  // Shared stream logic — used by both send() and sendVoiceMessage()
  const streamAndUpdate = useCallback(async (userMsg: Msg, allMessages: Msg[], sendingAsNewSession: boolean, msgComplexity: 'simple' | 'standard' | 'complex' = 'standard') => {
    let assistantSoFar = '';
    const lastUserIdx = allMessages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1);
    const cleanMessages = allMessages.map(({ role, content }, idx) => {
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
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    await streamChat({
      messages: cleanMessages,
      userRole: role || 'member',
      newSession: sendingAsNewSession,
      complexity: msgComplexity,
      signal: abortRef.current.signal,
      onStatus: () => {
        // Reset activity timeout so tool execution keeps connection alive
        if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current);
        doneTimeoutRef.current = setTimeout(() => {
          warn('[JanusDrawer] 30s activity timeout — forcing idle');
          setIsLoading(false); setToolSteps([]); sendingRef.current = false;
        }, 30_000);
      },
      onStepStart: (label) => {
        setToolSteps(prev => {
          // Don't add duplicate
          if (prev.some(s => s.label === label)) return prev;
          return [...prev, { label, done: false }];
        });
      },
      onStepDone: (label) => {
        setToolSteps(prev => prev.map(s => s.label === label ? { ...s, done: true } : s));
      },
      onDelta: (chunk) => {
        assistantSoFar += chunk;
        setToolSteps([]); // clear steps when content starts flowing
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant') {
            return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantSoFar } : m);
          }
          return [...prev, { role: 'assistant', content: assistantSoFar }];
        });
        // Reset activity timeout (30s to allow for TTS synthesis after text completes)
        if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current);
        doneTimeoutRef.current = setTimeout(() => {
          warn('[JanusDrawer] 30s activity timeout — forcing idle');
          setIsLoading(false); setToolSteps([]); sendingRef.current = false;
        }, 30_000);
      },
      onImageData: (dataUrl) => {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `![Generated image](${dataUrl})` } as Msg,
        ]);
      },
      onVoiceAudio: (audio) => {
        log(`[JanusDrawer] voice_audio received (${audio.length} chars)`);
        // Reset activity timeout on voice audio
        if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current);
        doneTimeoutRef.current = setTimeout(() => {
          warn('[JanusDrawer] 30s activity timeout — forcing idle');
          setIsLoading(false); setToolSteps([]); sendingRef.current = false;
        }, 30_000);
        // Programmatically play the audio
        try {
          const audioEl = new Audio(`data:audio/mpeg;base64,${audio}`);
          audioEl.play().catch((e) => warn('[JanusDrawer] Audio autoplay blocked:', e));
        } catch (e) {
          warn('[JanusDrawer] Audio playback error:', e);
        }
        setMessages((prev) => {
          const lastIdx = prev.length - 1;
          const last = prev[lastIdx];
          if (last?.role === 'assistant') {
            return prev.map((m, i) => i === lastIdx ? { ...m, voiceAudio: audio } : m);
          }
          return prev;
        });
      },
      onUrlCorrections: (correctedText, deadUrls) => {
        console.log(`[JanusDrawer] URL corrections: ${deadUrls.length} dead link(s) replaced`);
        assistantSoFar = correctedText;
        setMessages((prev) => {
          const lastIdx = prev.length - 1;
          const last = prev[lastIdx];
          if (last?.role === 'assistant') {
            return prev.map((m, i) => i === lastIdx ? { ...m, content: correctedText } : m);
          }
          return prev;
        });
      },
      onVoiceTranscript: (transcript) => {
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === 'user') {
              const msg = prev[i];
              const hasAudio = Array.isArray(msg.content)
                ? msg.content.some((p: ContentPart) => p.type === 'input_audio')
                : false;
              if (hasAudio) {
                return prev.map((m, idx) =>
                  idx === i ? { ...m, _voiceTranscript: transcript } : m
                );
              }
              break;
            }
          }
          return prev;
        });
      },
      onDone: () => { if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current); setIsLoading(false); setToolSteps([]); sendingRef.current = false; },
      onError: (status, detail) => {
        if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current);
        setIsLoading(false);
        setToolSteps([]);
        sendingRef.current = false;
        const msg = janusErrorMessage(status, detail);
        setMessages((prev) => [...prev, { role: 'assistant', content: msg, _error: true }]);
        if (shouldToastJanusError(status)) {
          toast({ title: 'Janus Error', description: msg, variant: 'destructive' });
        }
      }
    });
  }, [role, toast]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0 || isLoading || sendingRef.current) return;

    sendingRef.current = true;

    const currentAttachments = [...attachments];
    setInput('');
    setAttachments([]);

    const content = buildMessageContent(text, currentAttachments);
    const userMsg: Msg = {
      role: 'user',
      content,
      _attachments: currentAttachments.length > 0 ? currentAttachments : undefined
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    setToolSteps([]);

    const sendingAsNewSession = isNewSession;
    setIsNewSession(false);

    const msgComplexity = classifyComplexity(text, currentAttachments);
    await streamAndUpdate(userMsg, [...messages, userMsg], sendingAsNewSession, msgComplexity);
  }, [input, attachments, isLoading, messages, buildMessageContent, isNewSession, streamAndUpdate]);

  // Auto-send voice — bypasses attachment state to avoid async timing issues
  const sendVoiceMessage = useCallback(async (dataUrl: string, format: string) => {
    if (isLoading || sendingRef.current) return;
    sendingRef.current = true;

    const base64 = dataUrl.split(',')[1] || dataUrl;
    const audioAttachment: Attachment = { type: 'audio', mimeType: `audio/${format}`, dataUrl, name: 'Voice message' };
    const content: ContentPart[] = [
      { type: 'text', text: 'Here is a voice message. Please listen and respond.' },
      { type: 'input_audio', input_audio: { data: base64, format } },
    ];
    const userMsg: Msg = { role: 'user', content, _attachments: [audioAttachment] };

    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    setToolSteps([]);

    const sendingAsNewSession = isNewSession;
    setIsNewSession(false);

    await streamAndUpdate(userMsg, [...messages, userMsg], sendingAsNewSession, 'complex'); // voice is complex
  }, [isLoading, isNewSession, messages, streamAndUpdate]);

  // Keep the forward ref in sync with latest sendVoiceMessage
  useEffect(() => { sendVoiceMessageRef.current = sendVoiceMessage; }, [sendVoiceMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
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

  const clearMessages = useCallback(() => {
    setMessages([{ role: 'assistant', content: '🔄 **New conversation started** — working memory cleared. I still remember all your permanent preferences and facts.' } as Msg]);
    setIsNewSession(true);
  }, []);

  const inputMatches = input.trim().length > 1 ? findMatchingSections(input) : [];

  // Get suggestion chips for the last assistant message
  const lastAssistantMsg = messages.length > 0 && messages[messages.length - 1]?.role === 'assistant'
    ? getTextContent(messages[messages.length - 1])
    : '';
  const suggestionChips = !isLoading && lastAssistantMsg ? getSuggestions(lastAssistantMsg) : [];

  return (
    <>
      {/* FAB button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-24 md:bottom-6 right-4 md:right-6 z-50 w-14 h-14 rounded-full overflow-hidden shadow-lg ring-2 ring-primary/30 hover:scale-110 hover:shadow-xl transition-all duration-200"
        aria-label={open ? 'Close Janus assistant' : 'Open Janus assistant'}
        style={{ padding: '2px' }}>

        {open ?
        <div className="w-full h-full rounded-full bg-primary flex items-center justify-center">
            <X className="h-6 w-6 text-primary-foreground" />
          </div> :

        <img alt="Janus" className="w-full h-full object-cover rounded-full p-1" src="/icon.svg" />
        }
      </button>

      {/* Popup */}
      {open &&
      <div className="fixed bottom-[88px] md:bottom-24 left-4 right-4 sm:left-auto sm:w-[400px] z-50 flex flex-col rounded-2xl border border-border shadow-2xl bg-background overflow-hidden animate-in slide-in-from-bottom-4 fade-in duration-200" style={{ maxHeight: 'calc(100dvh - 116px)' }}>
      {/* Accent header banner */}
      <div className="flex-shrink-0 bg-primary px-4 py-3 rounded-t-2xl">
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={janusIcon} alt="Janus" className="w-9 h-9 rounded-xl" />
              <div>
                <span className="text-base font-bold tracking-wide text-primary-foreground">JANUS</span>
                <p className="text-xs text-primary-foreground/80">I'm here to help. Ask me anything.</p>
              </div>
            </div>
            {messages.length > 0 &&
            <Button variant="ghost" size="icon" className="h-8 w-8 text-primary-foreground hover:bg-primary-foreground/10" onClick={clearMessages}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            }
            <Button variant="ghost" size="icon" className="h-8 w-8 text-primary-foreground hover:bg-primary-foreground/10" onClick={() => { setOpen(false); navigate('/projects'); }} title="Project Mode">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-primary-foreground hover:bg-primary-foreground/10" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Chat area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 &&
          <div className="flex flex-col items-center justify-center gap-4 py-16 text-center flex-1">
              <div className="text-muted-foreground/40">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
                  <path d="M18 14l.7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-1">Hey, I'm Janus!</h3>
                <p className="text-sm text-muted-foreground max-w-[260px] leading-relaxed">
                  I'm here to help you manage the house. Ask me about systems, schedules, or anything Janus.
                </p>
              </div>
              <p className="text-xs text-muted-foreground/60 mt-2">
                📎 Attach photos, PDFs & docs · 🎙 Send voice messages
              </p>
              <div className="flex flex-wrap gap-2 justify-center mt-2">
                {['Security', 'Teslas', 'Pool & Spa', 'Calendar'].map((label) =>
              <button
                key={label}
                onClick={() => setInput(label)}
                className="text-xs px-3 py-1.5 rounded-full border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
                    {label}
                  </button>
              )}
              </div>
            </div>
          }

          {messages.map((msg, i) =>
          msg._error ?
          <div
            key={i}
            data-testid={`message-error-${i}`}
            className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
          >
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{getTextContent(msg)}</span>
            </div> :
          <div key={i} className={`flex gap-2.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'assistant' &&
            <img src={janusIcon} alt="Janus" className="w-7 h-7 rounded-lg mt-1 flex-shrink-0" />
            }
              <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm ${
            msg.role === 'user' ?
            'bg-primary text-primary-foreground' :
            'bg-card border border-border'}`
            }>
              {msg.role === 'user' && msg._attachments && msg._attachments.length > 0 &&
              <div className="flex flex-wrap gap-1.5 mb-2">
                    {msg._attachments.map((att, j) =>
                <div key={j}>
                        {att.type === 'image' &&
                  <img src={att.dataUrl} alt="Attached" className="rounded-lg max-h-32 max-w-full object-cover" />
                  }
                        {att.type === 'video' &&
                  <video src={att.dataUrl} controls className="rounded-lg max-h-32 max-w-full" />
                  }
                        {att.type === 'audio' &&
                  <div className="flex items-center gap-1.5 text-xs opacity-80">
                            <Mic className="h-3 w-3" />
                            <span>{msg._voiceTranscript ? `"${msg._voiceTranscript}"` : 'Voice message'}</span>
                          </div>
                  }
                        {(att.type === 'document' || att.type === 'extracted') &&
                  <div className="flex items-center gap-1.5 text-xs opacity-80">
                            <FileText className="h-3 w-3" />
                            <span>{att.name || 'Document'}</span>
                          </div>
                  }
                      </div>
                )}
                  </div>
              }
                {msg.role === 'assistant' ? (
                <div className="space-y-2">
                  {msg.voiceAudio && (
                    <audio
                      src={`data:audio/mpeg;base64,${msg.voiceAudio}`}
                      controls
                      autoPlay
                      className="w-full rounded-lg"
                      style={{ height: '40px' }}
                    />
                  )}
                  <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:my-1">
                    <ReactMarkdown
                      components={{
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                        ),
                        img: ({ src, alt }) => (
                          <img
                            src={src}
                            alt={alt || 'Generated image'}
                            className="rounded-xl max-w-full mt-2 cursor-pointer border border-border block"
                            onClick={() => src && window.open(src, '_blank')}
                          />
                        ),
                      }}
                    >{getTextContent(msg)}</ReactMarkdown>
                  </div>
                </div>
              ) :
              <p className="whitespace-pre-wrap">{getTextContent(msg)}</p>
              }
              </div>
            </div>
          )}

          {/* Suggestion chips after last assistant message */}
          {suggestionChips.length > 0 && !isLoading &&
            <div className="flex flex-wrap gap-1.5 pl-9">
              {suggestionChips.map((chip) =>
                <button
                  key={chip}
                  onClick={() => { setInput(chip); setTimeout(send, 50); }}
                  className="text-xs px-2.5 py-1 rounded-full border border-primary/20 text-primary hover:bg-primary/10 transition-colors">
                  {chip}
                </button>
              )}
            </div>
          }

          {isLoading && messages[messages.length - 1]?.role === 'user' &&
          <div className="flex gap-2.5">
              <img src={janusIcon} alt="Janus" className="w-7 h-7 rounded-lg mt-1 flex-shrink-0" />
              <div className="bg-card border border-border rounded-xl px-3.5 py-3 space-y-1.5 min-w-[120px]">
                {toolSteps.length > 0 ? (
                  /* Step-by-step tool timeline */
                  <div className="space-y-1">
                    {toolSteps.map((step, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        {step.done ? (
                          <Check className="h-3 w-3 text-green-500 flex-shrink-0" />
                        ) : (
                          <Loader2 className="h-3 w-3 animate-spin text-primary flex-shrink-0" />
                        )}
                        <span className={step.done ? 'text-muted-foreground line-through' : 'text-foreground'}>
                          {step.label}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  /* Default bouncing dots */
                  <div className="flex gap-1 items-center">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
                  </div>
                )}
              </div>
            </div>
          }
        </div>

        {/* Quick nav suggestions */}
        {inputMatches.length > 0 &&
        <div className="px-4 pb-1 flex flex-wrap gap-1.5">
            {inputMatches.slice(0, 3).map((s) =>
          <button
            key={s.path}
            onClick={() => navigateTo(s.path)}
            className="text-xs px-2.5 py-1 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex items-center gap-1">

                Go to {s.name} →
              </button>
          )}
          </div>
        }

        {/* Attachment preview bar */}
        {attachments.length > 0 &&
        <div className="px-4 pb-1 flex gap-2 overflow-x-auto">
            {attachments.map((att, i) =>
          <div key={i} className="relative group flex-shrink-0">
                {att.type === 'image' &&
            <img src={att.dataUrl} alt="Preview" className="h-14 w-14 rounded-lg object-cover border border-border" />
            }
                {att.type === 'video' &&
            <div className="h-14 w-14 rounded-lg border border-border bg-muted flex items-center justify-center">
                    <Video className="h-5 w-5 text-muted-foreground" />
                  </div>
            }
                {att.type === 'audio' &&
            <div className="h-14 px-3 rounded-lg border border-border bg-muted flex items-center gap-1.5">
                    <Mic className="h-4 w-4 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">Voice</span>
                  </div>
            }
                {(att.type === 'document' || att.type === 'extracted') &&
            <div className="h-14 w-14 rounded-lg border border-border bg-muted flex flex-col items-center justify-center gap-0.5 p-1">
                    <FileText className="h-5 w-5 text-muted-foreground" />
                    <span className="text-[9px] text-muted-foreground text-center leading-tight truncate w-full text-center">
                      {att.name.split('.').pop()?.toUpperCase()}
                    </span>
                  </div>
            }
                <button
              onClick={() => removeAttachment(i)}
              className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">

                  <X className="h-3 w-3" />
                </button>
              </div>
          )}
          </div>
        }

        {/* Input bar */}
        <div className="border-t border-border px-3 py-3 flex-shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,application/pdf,text/plain,text/csv,text/markdown,text/html,.docx,.xlsx,.xls,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            multiple
            className="hidden"
            onChange={(e) => handleFileSelect(e.target.files)} />

          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*,video/*"
            capture="environment"
            className="hidden"
            onChange={(e) => handleFileSelect(e.target.files)} />


          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 flex-shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
              title="Attach photo, video, PDF, or document">

              <Paperclip className="h-5 w-5" />
            </Button>

            <div className="flex-1 relative">
              <Textarea
                value={isRecording ? '' : input}
                onChange={(e) => !isRecording && setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={isRecording ? '🔴 Recording… tap mic to send' : 'Type or tap 🎙 to talk...'}
                readOnly={isRecording}
                className={`resize-none min-h-[40px] max-h-28 text-sm rounded-full px-4 py-2.5 border-primary/30 focus-visible:ring-primary/40 ${isRecording ? 'pointer-events-none border-destructive/50 placeholder:text-destructive' : ''}`}
                rows={1} />

            </div>

            {input.trim() || attachments.length > 0 ?
            <Button
              onClick={send}
              disabled={isLoading}
              size="icon"
              className="flex-shrink-0 h-9 w-9 rounded-full">

                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button> :

            <Button
              variant={isRecording ? 'destructive' : 'ghost'}
              size="icon"
              className={`flex-shrink-0 h-9 w-9 rounded-full text-primary ${isRecording ? 'animate-pulse text-destructive-foreground' : ''}`}
              onClick={() => isRecording ? stopRecording() : startRecording()}
              title={isRecording ? 'Tap to stop recording' : 'Tap to start recording'}>

                {isRecording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </Button>
            }
          </div>
        </div>
      </div>
      }
    </>);

}
