import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Keyboard, Trash2, Send, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { useUserRole } from '@/hooks/useUserRole';
import { useAuth } from '@/hooks/useAuth';
import janusIcon from '@/assets/janus-icon.png';
import ReactMarkdown from 'react-markdown';

import {
  type Msg,
  type ContentPart,
  getTextContent,
  getAuthToken,
  streamChat,
  fileToBase64,
  convertToWav,
  janusErrorMessage,
  shouldToastJanusError,
  CHAT_URL,
} from '@/lib/janus/shared';

type JanusState = 'idle' | 'listening' | 'processing' | 'speaking';

// ── Audible "sent" cue — plays a short chime tone ──────────────────────────
function playSentCue() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.08); // D6
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => ctx.close();
  } catch { /* silent fallback */ }
}

// ── Component ──────────────────────────────────────────────────────────
export default function JanusFullscreen() {
  const { user } = useAuth();
  const { role } = useUserRole();
  const { toast } = useToast();

  const [messages, setMessages] = useState<Msg[]>([]);
  const [janusState, setJanusState] = useState<JanusState>('idle');
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [autoListen, setAutoListen] = useState(true);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const sendingRef = useRef(false);
  const autoListenRef = useRef(autoListen);

  // Keep ref in sync
  useEffect(() => { autoListenRef.current = autoListen; }, [autoListen]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // ── Auth guard ─────────────────────────────────────────────────────
  // Load history on mount
  useEffect(() => {
    if (!user || historyLoaded) return;
    (async () => {
      try {
        const token = await getAuthToken();
        const resp = await fetch(CHAT_URL, { method: 'GET', credentials: 'include', headers: { Authorization: `Bearer ${token}` } });
        if (resp.ok) {
          const data = await resp.json();
          if (data.history?.length) {
            setMessages(data.history.map((h: { role: string; content: string }) => ({
              role: h.role as 'user' | 'assistant', content: h.content,
            })));
          }
        }
      } catch (e) { console.error('Failed to load history:', e); }
      setHistoryLoaded(true);
    })();
  }, [user, historyLoaded]);

  // ── Ref for janusState (needed before startRecording) ──
  const janusStateRef = useRef(janusState);
  useEffect(() => { janusStateRef.current = janusState; }, [janusState]);

  // ── Mic permission + auto-start listening (like Hey Google) ────────
  useEffect(() => {
    if (!user) return;
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
      .then((s) => {
        streamRef.current = s;
        console.log('[Voice] Mic permission granted, auto-starting in 500ms');
        setTimeout(() => startRecordingRef.current(), 500);
      })
      .catch(() => {
        toast({ title: 'Microphone Required', description: 'Please allow mic access for voice mode.', variant: 'destructive' });
      });
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ── Recording ──────────────────────────────────────────────────────
  const sendVoiceMessageRef = useRef<(dataUrl: string, format: string) => void>(() => {});
  const startRecording = useCallback((stream?: MediaStream) => {
    // Always get a fresh stream to avoid stale/silent tracks
    const existing = streamRef.current;
    if (existing) {
      existing.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
      .then((freshStream) => {
        streamRef.current = freshStream;
        console.log('[Voice] Fresh stream obtained, tracks:', freshStream.getAudioTracks().map(t => `${t.label} state=${t.readyState}`));

        // 300ms warm-up delay so mic hardware actually produces audio
        setTimeout(() => {
          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';

          const recorder = new MediaRecorder(freshStream, mimeType ? { mimeType } : undefined);
          audioChunksRef.current = [];
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              audioChunksRef.current.push(e.data);
              console.log(`[Voice] chunk ${audioChunksRef.current.length}: ${e.data.size} bytes`);
            }
          };
          recorder.onstop = async () => {
            const finalMime = mimeType || 'audio/webm';
            const blob = new Blob(audioChunksRef.current, { type: finalMime });
            console.log(`[Voice] Recording stopped: ${blob.size} bytes, ${audioChunksRef.current.length} chunks`);
            if (blob.size < 2000) { console.warn('[Voice] Discarding tiny blob (<2KB)'); return; }
            let finalBlob = blob;
            let format = finalMime.includes('mp4') ? 'mp4' : 'webm';
            try {
              finalBlob = await convertToWav(blob);
              format = 'wav';
              console.log('[Voice] Converted to WAV:', finalBlob.size, 'bytes');
            } catch (e) {
              console.warn('[Voice] WAV conversion failed, sending raw audio:', e);
            }
            const dataUrl = await fileToBase64(new File([finalBlob], `voice.${format}`, { type: format === 'wav' ? 'audio/wav' : finalMime }));
            sendVoiceMessageRef.current(dataUrl, format);
          };

          mediaRecorderRef.current = recorder;
          // No timeslice — single clean chunk
          recorder.start();
          recordingStartTimeRef.current = Date.now();
          setJanusState('listening');
          console.log('[Voice] MediaRecorder started (no timeslice)');
        }, 300);
      })
      .catch(() => {
        toast({ title: 'Microphone Access', description: 'Please allow mic access.', variant: 'destructive' });
      });
  }, [toast]);

  // ── Keep a ref to startRecording to avoid stale closures ──────────
  const startRecordingRef = useRef(startRecording);
  useEffect(() => { startRecordingRef.current = startRecording; }, [startRecording]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording') {
      const elapsed = Date.now() - recordingStartTimeRef.current;
      const MIN_RECORDING_MS = 1500;
      if (elapsed < MIN_RECORDING_MS) {
        setTimeout(() => {
          if (recorder.state === 'recording') {
            playSentCue();
            recorder.stop();
          }
        }, MIN_RECORDING_MS - elapsed);
        return;
      }
      playSentCue();
      recorder.stop();
    }
  }, []);

  // ── Send voice message ─────────────────────────────────────────────
  const sendVoiceMessage = useCallback((dataUrl: string, format: string) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setJanusState('processing');

    const base64 = dataUrl.split(',')[1] || dataUrl;
    const userMsg: Msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'Here is a voice message. Please listen and respond.' },
        { type: 'input_audio', input_audio: { data: base64, format } },
      ],
    };

    setMessages(prev => [...prev, userMsg]);
    const allMessages = [...messages, userMsg];

    let assistantSoFar = '';
    let gotResponse = false;

    // Hard timeout — only reset if the entire stream stalls for too long
    const hardTimeout = setTimeout(() => {
      console.warn('[Voice] Hard timeout — stream stalled for 45s, resetting');
      sendingRef.current = false;
      setToolStatus(null);
      setJanusState('idle');
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role !== 'assistant') {
          return [...prev, { role: 'assistant', content: "I’m still waiting on the voice response — please try again." }];
        }
        return prev;
      });
      if (autoListenRef.current) setTimeout(() => startRecording(), 1000);
    }, 45000);

    // Grace timer — while waiting for TTS after text delta, do NOT reset/auto-listen early
    let activityTimer: ReturnType<typeof setTimeout> | null = null;
    const resetActivityTimer = () => {
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        console.log('[Voice] Waiting for TTS audio… keeping stream open');
        setToolStatus('Finishing voice reply…');
      }, 30000);
    };
    const clearActivityTimer = () => { if (activityTimer) clearTimeout(activityTimer); };

    streamChat({
      messages: allMessages,
      userRole: role || 'member',
      onStatus: (status) => { gotResponse = true; resetActivityTimer(); setToolStatus(status); },
      onDelta: (chunk) => {
        gotResponse = true;
        resetActivityTimer();
        assistantSoFar += chunk;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant') {
            return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantSoFar } : m);
          }
          return [...prev, { role: 'assistant', content: assistantSoFar }];
        });
      },
      onImageData: (dataUrl) => {
        gotResponse = true;
        setMessages(prev => [...prev, { role: 'assistant', content: `![Generated image](${dataUrl})` }]);
      },
      onVoiceAudio: (audio) => {
        gotResponse = true;
        clearActivityTimer();
        clearTimeout(hardTimeout);
        setJanusState('speaking');
        const audioEl = new Audio(`data:audio/mpeg;base64,${audio}`);
        audioEl.onended = () => {
          setJanusState('idle');
          if (autoListenRef.current) {
            setTimeout(() => startRecording(), 300);
          }
        };
        audioEl.play().catch(() => {
          setJanusState('idle');
          if (autoListenRef.current) setTimeout(() => startRecording(), 300);
        });

        // Attach audio to last assistant message
        setMessages(prev => {
          const lastIdx = prev.length - 1;
          if (prev[lastIdx]?.role === 'assistant') {
            return prev.map((m, i) => i === lastIdx ? { ...m, voiceAudio: audio } : m);
          }
          return prev;
        });
      },
      onUrlCorrections: (correctedText, deadUrls) => {
        console.log(`[JanusFullscreen] URL corrections: ${deadUrls.length} dead link(s) replaced`);
        assistantSoFar = correctedText;
        setMessages(prev => {
          const lastIdx = prev.length - 1;
          if (prev[lastIdx]?.role === 'assistant') {
            return prev.map((m, i) => i === lastIdx ? { ...m, content: correctedText } : m);
          }
          return prev;
        });
      },
      onVoiceTranscript: (transcript) => {
        setMessages(prev => {
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
      onDone: () => {
        gotResponse = true;
        clearActivityTimer();
        clearTimeout(hardTimeout);
        setToolStatus(null);
        sendingRef.current = false;
        // If no voice audio came back, resume listening
        setJanusState(prev => {
          if (prev !== 'speaking' && autoListenRef.current) {
            setTimeout(() => startRecording(), 300);
            return 'idle';
          }
          return prev;
        });
      },
      onError: (status, detail) => {
        gotResponse = true;
        clearActivityTimer();
        clearTimeout(hardTimeout);
        setToolStatus(null);
        sendingRef.current = false;
        setJanusState('idle');
        const msg = janusErrorMessage(status, detail);
        setMessages(prev => [...prev, { role: 'assistant', content: msg, _error: true }]);
        if (shouldToastJanusError(status)) {
          toast({ title: 'Janus Error', description: msg, variant: 'destructive' });
        }
        if (autoListenRef.current) setTimeout(() => startRecording(), 1000);
      },
    });
  }, [messages, role, toast, startRecording]);

  useEffect(() => { sendVoiceMessageRef.current = sendVoiceMessage; }, [sendVoiceMessage]);

  // ── Send text message ──────────────────────────────────────────────
  const sendText = useCallback(() => {
    const text = textInput.trim();
    if (!text || sendingRef.current) return;
    sendingRef.current = true;
    setJanusState('processing');
    setTextInput('');

    const userMsg: Msg = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    const allMessages = [...messages, userMsg];

    let assistantSoFar = '';
    streamChat({
      messages: allMessages,
      userRole: role || 'member',
      onStatus: (status) => setToolStatus(status),
      onDelta: (chunk) => {
        assistantSoFar += chunk;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant') {
            return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantSoFar } : m);
          }
          return [...prev, { role: 'assistant', content: assistantSoFar }];
        });
      },
      onImageData: (dataUrl) => {
        setMessages(prev => [...prev, { role: 'assistant', content: `![Generated image](${dataUrl})` }]);
      },
      onUrlCorrections: (correctedText, deadUrls) => {
        console.log(`[JanusFullscreen] URL corrections (text): ${deadUrls.length} dead link(s)`);
        assistantSoFar = correctedText;
        setMessages(prev => {
          const lastIdx = prev.length - 1;
          if (prev[lastIdx]?.role === 'assistant') {
            return prev.map((m, i) => i === lastIdx ? { ...m, content: correctedText } : m);
          }
          return prev;
        });
      },
      onVoiceAudio: (audio) => {
        // Typed messages can still receive a spoken reply — play it back
        // and attach the audio to the last assistant message.
        setJanusState('speaking');
        const audioEl = new Audio(`data:audio/mpeg;base64,${audio}`);
        audioEl.onended = () => setJanusState('idle');
        audioEl.play().catch(() => setJanusState('idle'));
        setMessages(prev => {
          const lastIdx = prev.length - 1;
          if (prev[lastIdx]?.role === 'assistant') {
            return prev.map((m, i) => i === lastIdx ? { ...m, voiceAudio: audio } : m);
          }
          return prev;
        });
      },
      onVoiceTranscript: () => {
        // No-op for the text-send path: there is no user audio to transcribe.
      },
      onDone: () => {
        setToolStatus(null);
        sendingRef.current = false;
        if (janusStateRef.current !== 'speaking') setJanusState('idle');
      },
      onError: (status, detail) => {
        setToolStatus(null);
        sendingRef.current = false;
        setJanusState('idle');
        const msg = janusErrorMessage(status, detail);
        setMessages(prev => [...prev, { role: 'assistant', content: msg, _error: true }]);
        if (shouldToastJanusError(status)) {
          toast({ title: 'Janus Error', description: msg, variant: 'destructive' });
        }
      },
    });
  }, [textInput, messages, role, toast]);

  // ── Mic button handler (uses refs to avoid stale closures) ─────────
  const handleMicTap = useCallback(() => {
    const currentState = janusStateRef.current;
    const recorder = mediaRecorderRef.current;
    if (currentState === 'listening' || recorder?.state === 'recording') {
      stopRecording();
    } else if (currentState === 'idle') {
      startRecording();
    }
  }, [startRecording, stopRecording]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  // ── Auth redirect ──────────────────────────────────────────────────
  if (!user) {
    return (
      <div className="h-[100dvh] flex items-center justify-center" style={{ background: '#141519' }}>
        <div className="text-center space-y-4">
          <img src={janusIcon} alt="Janus" className="w-16 h-16 mx-auto rounded-full" />
          <p className="text-white/60 text-sm">Sign in to use Janus</p>
          <Button variant="outline" onClick={() => window.location.href = '/'}>Sign In</Button>
        </div>
      </div>
    );
  }

  const stateLabel = janusState === 'listening' ? 'Listening…'
    : janusState === 'processing' ? (toolStatus || 'Thinking…')
    : janusState === 'speaking' ? 'Speaking…'
    : 'Tap to speak';

  return (
    <div
      className="h-[100dvh] flex flex-col"
      style={{
        background: '#141519',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <img src={janusIcon} alt="Janus" className="w-8 h-8 rounded-full" />
          <span className="text-white font-display font-semibold text-lg tracking-wide">JANUS</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoListen(!autoListen)}
            className={`text-xs px-2 py-1 rounded-full transition-colors ${
              autoListen ? 'bg-primary/20 text-primary' : 'bg-white/10 text-white/40'
            }`}
          >
            {autoListen ? 'Auto' : 'Manual'}
          </button>
          <Button variant="ghost" size="icon" onClick={clearMessages} className="text-white/40 hover:text-white">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Transcript area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-white/30 text-sm space-y-2">
            <img src={janusIcon} alt="" className="w-12 h-12 rounded-full opacity-40" />
            <p>Say something to get started</p>
          </div>
        )}
        {messages.map((msg, i) => {
          const text = msg._voiceTranscript || getTextContent(msg);
          if (!text) return null;
          if (msg._error) {
            return (
              <div
                key={i}
                data-testid={`message-error-${i}`}
                className="text-sm leading-relaxed flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-300"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{text}</span>
              </div>
            );
          }
          return (
            <div key={i} className={`text-sm leading-relaxed ${msg.role === 'user' ? 'text-white/50' : 'text-white/90'}`}>
              <span className="font-semibold text-xs uppercase tracking-wider mr-2"
                style={{ color: msg.role === 'user' ? 'hsl(var(--primary))' : 'hsl(var(--accent))' }}>
                {msg.role === 'user' ? 'You' : 'Janus'}
              </span>
              {msg.role === 'assistant' ? (
                <span className="inline [&>p]:inline [&>p:first-child]:inline">
                  <ReactMarkdown
                    components={{
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                      ),
                      img: ({ src, alt }) => (
                        <img src={src} alt={alt || ''} className="rounded-lg max-w-full mt-2 block" style={{ maxHeight: 240 }} />
                      ),
                    }}
                  >
                    {text}
                  </ReactMarkdown>
                </span>
              ) : (
                <span>{text}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Voice control area */}
      <div className="flex flex-col items-center pb-6 pt-3 gap-4">
        {/* State label — placed well above the mic */}
        <div className="text-white/40 text-xs tracking-[0.2em] uppercase font-medium select-none">
          {stateLabel}
        </div>

        {/* Mic button with pulse ring — self-contained, no overlap */}
        <div className="relative flex items-center justify-center" style={{ width: 96, height: 96 }}>
          {janusState === 'listening' && (
            <>
              <div className="pointer-events-none absolute inset-0 rounded-full bg-primary/25 animate-ping" style={{ animationDuration: '1.4s' }} />
              <div className="pointer-events-none absolute inset-[-6px] rounded-full border-2 border-primary/30 animate-pulse" />
            </>
          )}
          {janusState === 'speaking' && (
            <div className="pointer-events-none absolute inset-[-4px] rounded-full border-2 border-accent/30 animate-pulse" />
          )}
          <button
            onClick={handleMicTap}
            disabled={janusState === 'processing' || janusState === 'speaking'}
            className={`relative z-10 w-[72px] h-[72px] rounded-full flex items-center justify-center transition-all shadow-lg ${
              janusState === 'listening'
                ? 'bg-primary text-primary-foreground scale-105'
                : janusState === 'processing'
                ? 'bg-white/10 text-white/30 cursor-wait'
                : janusState === 'speaking'
                ? 'bg-accent/20 text-accent cursor-default'
                : 'bg-white/10 text-white/70 hover:bg-white/20 active:scale-95'
            }`}
          >
            {janusState === 'processing' ? (
              <Loader2 className="h-7 w-7 animate-spin" />
            ) : janusState === 'listening' ? (
              <Mic className="h-7 w-7" />
            ) : (
              <MicOff className="h-7 w-7" />
            )}
          </button>
        </div>

        {/* Keyboard toggle — larger touch target, clearly separate */}
        <button
          onClick={() => setShowKeyboard(!showKeyboard)}
          className="flex items-center justify-center w-10 h-10 rounded-lg bg-white/5 text-white/30 hover:text-white/60 hover:bg-white/10 active:bg-white/15 transition-colors"
          aria-label="Toggle keyboard input"
        >
          <Keyboard className="h-5 w-5" />
        </button>

        {/* Text input fallback */}
        {showKeyboard && (
          <div className="w-full px-4 flex gap-2">
            <Textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } }}
              placeholder="Type a message…"
              className="min-h-[40px] max-h-[80px] resize-none bg-white/5 border-white/10 text-white placeholder:text-white/30 text-sm"
              rows={1}
            />
            <Button
              size="icon"
              onClick={sendText}
              disabled={!textInput.trim() || sendingRef.current}
              className="shrink-0 bg-primary hover:bg-primary/90"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
