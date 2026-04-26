'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useUser, UserButton } from '@clerk/nextjs';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mic, Send, Upload, FileText, Settings, History, MessageSquare,
  Sparkles, X, Menu, Trash2, Info, Volume2, VolumeX, BookOpen,
  ImageIcon, Loader2, CheckCircle2, AlertCircle, ChevronRight,
} from 'lucide-react';
import VoiceVisualizer from '@/components/VoiceVisualizer';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

type Message = {
  role: 'user' | 'ai';
  content: string;
  citations?: number[];
  suggestions?: string[];
  imageUrl?: string;
};

type UploadedFile = { name: string; status: 'indexing' | 'ready' | 'error' };

const CITATION_MARKER = '\n[CITATIONS]';
const API = process.env.NEXT_PUBLIC_BACKEND_URL ?? '';

export default function EchoPDF() {
  const { user, isLoaded } = useUser();
  const userId = user?.id ?? '';

  const [messages,        setMessages]        = useState<Message[]>([]);
  const [isRecording,     setIsRecording]     = useState(false);
  const [isUploading,     setIsUploading]     = useState(false);
  const [input,           setInput]           = useState('');
  const [uploadedFiles,   setUploadedFiles]   = useState<UploadedFile[]>([]);
  const [activeFile,      setActiveFile]      = useState<string | null>(null);
  const [sidebarOpen,     setSidebarOpen]     = useState(false);
  const [showHistory,     setShowHistory]     = useState(false);
  const [showSettings,    setShowSettings]    = useState(false);
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const [voiceReply,      setVoiceReply]      = useState(false);
  const [isStreaming,     setIsStreaming]      = useState(false);
  const [attachedImage,   setAttachedImage]   = useState<File | null>(null);
  const [imagePreview,    setImagePreview]    = useState<string | null>(null);

  const scrollRef       = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef  = useRef<Blob[]>([]);
  const imageInputRef   = useRef<HTMLInputElement>(null);

  // ── Auto-scroll ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // ── Load user's PDFs on sign-in ──────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    fetch(`${API}/my_pdfs/${userId}`)
      .then(r => r.json())
      .then(d => setUploadedFiles(d.files ?? []))
      .catch(() => {});
  }, [userId]);

  // ── Poll indexing status ──────────────────────────────────────────────────────
  useEffect(() => {
    const indexing = uploadedFiles.filter(f => f.status === 'indexing');
    if (!indexing.length) return;
    const id = setInterval(async () => {
      for (const f of indexing) {
        try {
          const r = await fetch(`${API}/index_status/${userId}/${encodeURIComponent(f.name)}`);
          const d = await r.json();
          if (d.status === 'ready' || d.status?.startsWith('error')) {
            setUploadedFiles(prev =>
              prev.map(p => p.name === f.name ? { ...p, status: d.status.startsWith('error') ? 'error' : 'ready' } : p)
            );
            if (d.status === 'ready') {
              const uploadMsg: Message = {
                role: 'ai',
                content: d.summary
                  ? `**"${f.name}" is ready.**\n\n${d.summary}`
                  : `**"${f.name}"** is indexed and ready!`,
                suggestions: d.questions ?? [],
              };
              setMessages(prev => [...prev, uploadMsg]);
            }
          }
        } catch { /* ignore */ }
      }
    }, 2500);
    return () => clearInterval(id);
  }, [uploadedFiles, userId]);

  // ── TTS ──────────────────────────────────────────────────────────────────────
  const stripMarkdown = (t: string) =>
    t.replace(/#{1,6}\s/g,'').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/\*([^*]+)\*/g,'$1')
     .replace(/`{1,3}[^`]*`{1,3}/g,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
     .replace(/^\s*[-*+]\s/gm,'').replace(/^\s*\d+\.\s/gm,'').replace(/>/g,'')
     .replace(/\n{2,}/g,'. ').replace(/\n/g,' ').trim();

  const speak = (text: string) => {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(stripMarkdown(text));
    u.rate = 1; u.pitch = 1;
    window.speechSynthesis.speak(u);
  };

  // ── History builder ───────────────────────────────────────────────────────────
  const buildHistory = (msgs: Message[]) =>
    msgs
      .filter(m => m.content && !m.content.startsWith('🎤 Transcri'))
      .map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }));

  // ── Core streaming ────────────────────────────────────────────────────────────
  const streamAiResponse = useCallback(async (formData: FormData) => {
    setIsStreaming(true);
    try {
      const res = await fetch(`${API}/chat_stream`, { method: 'POST', body: formData });
      const reader = res.body?.getReader();
      if (!reader) return;

      setMessages(prev => [...prev, { role: 'ai', content: '' }]);
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += new TextDecoder().decode(value);
        const display = acc.split(CITATION_MARKER)[0];
        setMessages(prev => {
          const u = [...prev];
          u[u.length - 1] = { ...u[u.length - 1], content: display };
          return u;
        });
      }
      const ci = acc.indexOf(CITATION_MARKER);
      let citations: number[] = [];
      if (ci !== -1) { try { citations = JSON.parse(acc.slice(ci + CITATION_MARKER.length)); } catch {} }
      const clean = ci !== -1 ? acc.slice(0, ci) : acc;
      setMessages(prev => { const u=[...prev]; u[u.length-1]={role:'ai',content:clean,citations}; return u; });
      if (voiceReply && clean) speak(clean);
    } finally {
      setIsStreaming(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceReply]);

  // ── Upload PDF ────────────────────────────────────────────────────────────────
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !userId) return;
    setIsUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('user_id', userId);
    try {
      const r    = await fetch(`${API}/upload_pdf`, { method: 'POST', body: fd });
      const data = await r.json();
      const name: string = data.filename ?? file.name;
      setUploadedFiles(prev => {
        const exists = prev.find(f => f.name === name);
        return exists ? prev.map(f => f.name === name ? { ...f, status: 'indexing' } : f)
                      : [...prev, { name, status: 'indexing' }];
      });
      setActiveFile(name);
      setMessages(prev => [...prev, {
        role: 'ai',
        content: `**"${name}"** is being indexed — this may take a moment for large PDFs with images...`,
      }]);
    } catch {
      setMessages(prev => [...prev, { role: 'ai', content: 'Upload failed. Please try again.' }]);
    } finally {
      setIsUploading(false);
    }
  };

  // ── Attach image ──────────────────────────────────────────────────────────────
  const handleImageAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachedImage(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const clearImage = () => { setAttachedImage(null); setImagePreview(null); };

  // ── Send (text or image) ──────────────────────────────────────────────────────
  const handleSend = async () => {
    if ((!input.trim() && !attachedImage) || isStreaming || !userId) return;
    const userMsg = input.trim() || 'What can you tell me about this image?';
    setInput('');
    const preview = imagePreview;
    clearImage();
    const history = buildHistory(messages);
    setMessages(prev => [...prev, { role: 'user', content: userMsg, imageUrl: preview ?? undefined }]);

    try {
      if (attachedImage || preview) {
        // Image question — use Gemini Vision endpoint
        const fd = new FormData();
        fd.append('question', userMsg);
        fd.append('user_id', userId);
        if (attachedImage) fd.append('image', attachedImage);
        setIsStreaming(true);
        setMessages(prev => [...prev, { role: 'ai', content: '' }]);
        try {
          const r    = await fetch(`${API}/ask_image`, { method: 'POST', body: fd });
          const data = await r.json();
          setMessages(prev => { const u=[...prev]; u[u.length-1]={role:'ai',content:data.answer??''}; return u; });
          if (voiceReply && data.answer) speak(data.answer);
        } finally { setIsStreaming(false); }
      } else {
        const fd = new FormData();
        fd.append('text_query', userMsg);
        fd.append('user_id', userId);
        if (activeFile) fd.append('filename', activeFile);
        fd.append('history', JSON.stringify(history));
        await streamAiResponse(fd);
      }
    } catch (err) { console.error(err); }
  };

  const handleSuggestion = async (question: string) => {
    if (isStreaming || !userId) return;
    const history = buildHistory(messages);
    setMessages(prev => [...prev, { role: 'user', content: question }]);
    try {
      const fd = new FormData();
      fd.append('text_query', question);
      fd.append('user_id', userId);
      if (activeFile) fd.append('filename', activeFile);
      fd.append('history', JSON.stringify(history));
      await streamAiResponse(fd);
    } catch (err) { console.error(err); }
  };

  // ── Voice recording ───────────────────────────────────────────────────────────
  const handleMicClick = async () => {
    if (isRecording) { mediaRecorderRef.current?.stop(); return; }
    const historySnapshot = buildHistory(messages);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setIsRecording(false);
        setIsProcessingVoice(true);
        setMessages(prev => [...prev, { role: 'user', content: '🎤 Transcribing…' }]);
        try {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const tf = new FormData();
          tf.append('audio', blob, 'recording.webm');
          const tr = await fetch(`${API}/transcribe`, { method: 'POST', body: tf });
          const { text } = await tr.json();
          setMessages(prev => { const u=[...prev]; u[u.length-1]={role:'user',content:text}; return u; });
          const cf = new FormData();
          cf.append('text_query', text);
          cf.append('user_id', userId);
          if (activeFile) cf.append('filename', activeFile);
          cf.append('history', JSON.stringify(historySnapshot));
          await streamAiResponse(cf);
        } catch {
          setMessages(prev => { const u=[...prev]; u[u.length-1]={role:'user',content:'🎤 Transcription failed'}; return u; });
        } finally { setIsProcessingVoice(false); }
      };
      mr.start();
      setIsRecording(true);
    } catch { alert('Microphone access denied.'); }
  };

  const handleNewChat = () => {
    setMessages([]); setSidebarOpen(false);
    window.speechSynthesis.cancel();
  };

  const switchFile = (name: string) => {
    setActiveFile(name);
    setSidebarOpen(false);
    setMessages([]);
  };

  const userMessages = messages.filter(m => m.role === 'user');

  if (!isLoaded) return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
    </div>
  );

  return (
    <main className="flex h-screen w-full bg-transparent overflow-hidden font-inter">

      {/* Mobile sidebar backdrop */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 bg-black/60 z-20 md:hidden" />
        )}
      </AnimatePresence>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside className={cn(
        "fixed md:relative top-0 left-0 h-full w-64 glass border-r border-white/10 flex flex-col p-4 z-30 transition-transform duration-300",
        "md:translate-x-0", sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Logo */}
        <div className="flex items-center justify-between mb-6 px-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(188,19,254,0.5)]">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold font-outfit tracking-tight">EchoPDF</h1>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="md:hidden text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* User */}
        <div className="flex items-center gap-3 px-2 mb-5 py-2 rounded-xl bg-white/5 border border-white/10">
          <UserButton appearance={{ variables: { colorPrimary: '#7c3aed' } }} />
          <div className="min-w-0">
            <p className="text-xs font-semibold truncate">{user?.firstName ?? 'User'}</p>
            <p className="text-[10px] text-gray-500 truncate">{user?.emailAddresses[0]?.emailAddress}</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="space-y-1 mb-4">
          <button onClick={handleNewChat}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors text-sm">
            <MessageSquare className="w-4 h-4 text-neon-blue" /><span>New Chat</span>
          </button>
          <button onClick={() => { setShowHistory(true); setSidebarOpen(false); }}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/5 transition-colors text-sm text-gray-400">
            <History className="w-4 h-4" /><span>History</span>
            {userMessages.length > 0 && (
              <span className="ml-auto text-xs bg-primary/30 text-primary px-2 py-0.5 rounded-full">{userMessages.length}</span>
            )}
          </button>
        </nav>

        {/* My Documents */}
        <div className="flex-1 min-h-0 flex flex-col">
          <p className="text-[10px] uppercase tracking-widest text-gray-500 px-2 mb-2">My Documents</p>
          <div className="flex-1 overflow-y-auto space-y-1">
            {uploadedFiles.length === 0 ? (
              <p className="text-xs text-gray-600 px-2 py-1">No PDFs yet</p>
            ) : uploadedFiles.map(f => (
              <button key={f.name} onClick={() => f.status === 'ready' && switchFile(f.name)}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-2 rounded-xl text-xs transition-all text-left",
                  activeFile === f.name ? "bg-primary/20 border border-primary/30 text-white" : "hover:bg-white/5 text-gray-400",
                  f.status !== 'ready' && "cursor-default"
                )}>
                {f.status === 'indexing' && <Loader2 className="w-3 h-3 shrink-0 animate-spin text-yellow-400" />}
                {f.status === 'ready'    && <CheckCircle2 className="w-3 h-3 shrink-0 text-green-400" />}
                {f.status === 'error'    && <AlertCircle  className="w-3 h-3 shrink-0 text-red-400" />}
                <span className="truncate flex-1">{f.name}</span>
                {activeFile === f.name && <ChevronRight className="w-3 h-3 shrink-0 text-primary" />}
              </button>
            ))}
          </div>

          {/* Upload button */}
          <label className={cn(
            "mt-3 w-full cursor-pointer flex items-center justify-center gap-2 py-2 rounded-xl",
            "bg-primary/10 hover:bg-primary/20 text-primary text-xs transition-colors border border-primary/20"
          )}>
            {isUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            {isUploading ? 'Uploading...' : 'Upload PDF'}
            <input type="file" className="hidden" accept=".pdf" onChange={handleUpload} disabled={isUploading || !userId} />
          </label>
        </div>

        {/* Settings */}
        <button onClick={() => { setShowSettings(true); setSidebarOpen(false); }}
          className="mt-3 w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/5 transition-colors text-sm text-gray-400">
          <Settings className="w-4 h-4" /><span>Settings</span>
        </button>
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────────── */}
      <section className="flex-1 flex flex-col relative min-w-0">
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-neon-purple blur-[120px] rounded-full" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-neon-blue blur-[120px] rounded-full" />
        </div>

        {/* Header */}
        <header className="h-14 flex items-center justify-between px-4 md:px-8 z-10 border-b border-white/5">
          <div className="flex items-center gap-3">
            <button onClick={() => setSidebarOpen(true)} className="md:hidden text-gray-400 hover:text-white p-1">
              <Menu className="w-5 h-5" />
            </button>
            {activeFile ? (
              <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/10 text-xs">
                <FileText className="w-3.5 h-3.5 text-neon-blue shrink-0" />
                <span className="max-w-[120px] md:max-w-[200px] truncate">{activeFile}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 bg-primary rounded-md flex items-center justify-center md:hidden">
                  <Sparkles className="w-3.5 h-3.5 text-white" />
                </div>
                <span className="text-sm font-semibold md:hidden">EchoPDF</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="cursor-pointer flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-xl text-xs transition-all">
              <Upload className="w-3.5 h-3.5 text-neon-blue" />
              <span className="hidden sm:inline">{isUploading ? 'Indexing...' : 'Upload PDF'}</span>
              <input type="file" className="hidden" accept=".pdf" onChange={handleUpload} disabled={isUploading || !userId} />
            </label>
            <div className="hidden md:block">
              <UserButton appearance={{ variables: { colorPrimary: '#7c3aed' } }} />
            </div>
          </div>
        </header>

        {/* Chat */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-8 py-4 space-y-4 z-10 scroll-smooth">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-4">
              <motion.div initial={{opacity:0,y:20}} animate={{opacity:1,y:0}} className="max-w-sm w-full">
                <div className="w-16 h-16 md:w-20 md:h-20 bg-white/5 rounded-3xl flex items-center justify-center mb-5 mx-auto border border-white/10">
                  <Upload className="w-8 h-8 md:w-10 md:h-10 text-gray-400" />
                </div>
                <h2 className="text-2xl md:text-3xl font-bold font-outfit mb-3">
                  Welcome{user?.firstName ? `, ${user.firstName}` : ''}
                </h2>
                <p className="text-gray-400 text-sm mb-7">Upload a PDF and ask questions using voice, text, or images.</p>
                <label className="cursor-pointer inline-block bg-primary hover:bg-primary/80 text-white px-8 py-3 rounded-2xl font-semibold transition-all shadow-[0_0_20px_rgba(188,19,254,0.3)] text-sm">
                  {isUploading ? 'Indexing...' : 'Upload PDF'}
                  <input type="file" className="hidden" accept=".pdf" onChange={handleUpload} disabled={isUploading || !userId} />
                </label>
              </motion.div>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {messages.map((msg, i) => (
                <motion.div key={i}
                  initial={{opacity:0, x: msg.role==='user'?20:-20}} animate={{opacity:1,x:0}}
                  className={cn("flex flex-col max-w-[85%] md:max-w-[75%]",
                    msg.role==='user' ? "ml-auto items-end" : "mr-auto items-start")}>

                  {/* Image preview in user bubble */}
                  {msg.imageUrl && (
                    <img src={msg.imageUrl} alt="attached" className="max-w-[200px] rounded-xl mb-1 border border-white/10" />
                  )}

                  <div className={cn("px-4 py-3 rounded-2xl text-sm leading-relaxed",
                    msg.role==='user'
                      ? "bg-primary text-white shadow-[0_4px_15px_rgba(188,19,254,0.2)]"
                      : "glass border border-white/5 text-gray-100")}>
                    {msg.role==='ai'
                      ? msg.content ? <MarkdownRenderer content={msg.content} /> : <span className="animate-pulse text-gray-500">Thinking...</span>
                      : msg.content}
                  </div>

                  {/* Citations */}
                  {msg.role==='ai' && msg.citations && msg.citations.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1.5 px-1 flex-wrap">
                      <BookOpen className="w-3 h-3 text-gray-500" />
                      <span className="text-xs text-gray-500">Sources:</span>
                      {msg.citations.map(page => (
                        <span key={page} className="text-xs bg-neon-blue/10 text-neon-blue border border-neon-blue/20 px-2 py-0.5 rounded-full">
                          Page {page}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Suggested questions */}
                  {msg.role==='ai' && msg.suggestions && msg.suggestions.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5 w-full">
                      {msg.suggestions.map((q, qi) => (
                        <button key={qi} onClick={() => handleSuggestion(q)} disabled={isStreaming}
                          className="text-xs text-left bg-white/5 hover:bg-white/10 border border-white/10 hover:border-primary/30 px-3 py-2 rounded-xl text-gray-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>

        {/* Input */}
        <footer className="p-3 md:p-6 z-10">
          <div className="max-w-3xl mx-auto space-y-2">
            {/* Image preview strip */}
            {imagePreview && (
              <motion.div initial={{opacity:0,y:8}} animate={{opacity:1,y:0}}
                className="flex items-center gap-2 px-3 py-2 glass rounded-xl border border-white/10">
                <img src={imagePreview} alt="preview" className="w-10 h-10 rounded-lg object-cover border border-white/10" />
                <span className="text-xs text-gray-400 flex-1 truncate">{attachedImage?.name}</span>
                <button onClick={clearImage} className="text-gray-500 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </motion.div>
            )}

            <div className={cn(
              "glass rounded-2xl p-2 flex items-center gap-2 border shadow-2xl transition-all",
              isStreaming ? "border-primary/30 shadow-[0_0_20px_rgba(188,19,254,0.1)]" : "border-white/10 focus-within:border-primary/50"
            )}>
              {/* Mic */}
              <button onClick={handleMicClick} disabled={isProcessingVoice || isStreaming}
                className={cn("w-10 h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center transition-all shrink-0",
                  isRecording ? "bg-red-500/20 text-red-400" : "hover:bg-white/5 text-gray-400",
                  (isProcessingVoice || isStreaming) && "opacity-40 cursor-not-allowed")}>
                <Mic className={cn("w-5 h-5", (isRecording||isProcessingVoice) && "animate-pulse")} />
              </button>

              {/* Image attach */}
              <button onClick={() => imageInputRef.current?.click()} disabled={isStreaming}
                className={cn("w-10 h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center transition-all shrink-0",
                  attachedImage ? "bg-neon-blue/20 text-neon-blue" : "hover:bg-white/5 text-gray-400",
                  isStreaming && "opacity-40 cursor-not-allowed")}>
                <ImageIcon className="w-4 h-4 md:w-5 md:h-5" />
              </button>
              <input ref={imageInputRef} type="file" className="hidden" accept="image/*" onChange={handleImageAttach} />

              {/* Text or status */}
              <div className="flex-1 min-w-0">
                {isRecording ? <VoiceVisualizer isRecording={isRecording} />
                  : isProcessingVoice ? <span className="px-2 text-sm text-gray-400 animate-pulse">Transcribing voice...</span>
                  : isStreaming ? <span className="px-2 text-sm text-gray-500 animate-pulse">Thinking...</span>
                  : (
                  <input type="text" value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key==='Enter' && handleSend()}
                    placeholder={attachedImage ? "Ask about this image..." : "Ask anything about the PDF..."}
                    className="w-full bg-transparent border-none outline-none px-2 py-2 text-sm placeholder:text-gray-500" />
                )}
              </div>

              {/* Voice reply toggle */}
              <button onClick={() => { setVoiceReply(v=>!v); window.speechSynthesis.cancel(); }}
                className={cn("w-10 h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center transition-all shrink-0",
                  voiceReply ? "bg-neon-blue/20 text-neon-blue" : "hover:bg-white/5 text-gray-500")}>
                {voiceReply ? <Volume2 className="w-4 h-4 md:w-5 md:h-5" /> : <VolumeX className="w-4 h-4 md:w-5 md:h-5" />}
              </button>

              {/* Send */}
              <button onClick={handleSend} disabled={(!input.trim() && !attachedImage) || isRecording || isStreaming}
                className="w-10 h-10 md:w-12 md:h-12 bg-primary/20 hover:bg-primary/40 disabled:opacity-30 text-neon-blue rounded-xl flex items-center justify-center transition-all shrink-0">
                {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4 md:w-5 md:h-5" />}
              </button>
            </div>
          </div>
        </footer>
      </section>

      {/* History Modal */}
      <AnimatePresence>
        {showHistory && (
          <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            onClick={() => setShowHistory(false)}
            className="fixed inset-0 bg-black/60 z-40 flex items-end md:items-center justify-center p-4">
            <motion.div initial={{y:50,opacity:0}} animate={{y:0,opacity:1}} exit={{y:50,opacity:0}}
              onClick={e => e.stopPropagation()}
              className="glass border border-white/10 rounded-2xl w-full max-w-md max-h-[70vh] flex flex-col overflow-hidden">
              <div className="flex items-center justify-between p-4 border-b border-white/10">
                <div className="flex items-center gap-2"><History className="w-4 h-4 text-neon-blue" /><h2 className="font-semibold text-sm">Chat History</h2></div>
                <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {userMessages.length === 0 ? (
                  <div className="text-center text-gray-500 text-sm py-8">
                    <History className="w-8 h-8 mx-auto mb-3 opacity-30" /><p>No messages yet</p>
                  </div>
                ) : userMessages.map((msg, i) => (
                  <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-white/5">
                    <span className="text-xs text-primary font-semibold shrink-0 mt-0.5">Q{i+1}</span>
                    <p className="text-sm text-gray-300 line-clamp-2">{msg.content}</p>
                  </div>
                ))}
              </div>
              {userMessages.length > 0 && (
                <div className="p-4 border-t border-white/10">
                  <button onClick={() => { handleNewChat(); setShowHistory(false); }}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm transition-colors">
                    <Trash2 className="w-4 h-4" />Clear Chat
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            onClick={() => setShowSettings(false)}
            className="fixed inset-0 bg-black/60 z-40 flex items-end md:items-center justify-center p-4">
            <motion.div initial={{y:50,opacity:0}} animate={{y:0,opacity:1}} exit={{y:50,opacity:0}}
              onClick={e => e.stopPropagation()}
              className="glass border border-white/10 rounded-2xl w-full max-w-md overflow-hidden">
              <div className="flex items-center justify-between p-4 border-b border-white/10">
                <div className="flex items-center gap-2"><Settings className="w-4 h-4 text-neon-blue" /><h2 className="font-semibold text-sm">Settings</h2></div>
                <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 space-y-3">
                <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                  <p className="text-xs text-gray-500 mb-1">Active Document</p>
                  {activeFile
                    ? <div className="flex items-center gap-2"><FileText className="w-4 h-4 text-neon-blue shrink-0" /><p className="text-sm truncate">{activeFile}</p></div>
                    : <p className="text-sm text-gray-500">No PDF selected</p>}
                </div>
                <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                  <div className="flex items-center gap-2 mb-2"><Info className="w-3.5 h-3.5 text-gray-500" /><p className="text-xs text-gray-500">Account</p></div>
                  <div className="flex items-center gap-2">
                    <UserButton />
                    <div><p className="text-xs">{user?.firstName} {user?.lastName}</p><p className="text-[10px] text-gray-500">{user?.emailAddresses[0]?.emailAddress}</p></div>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                  <div className="flex items-center gap-2 mb-1"><Info className="w-3.5 h-3.5 text-gray-500" /><p className="text-xs text-gray-500">Backend</p></div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]" />
                    <p className="text-xs text-gray-400">HuggingFace Space · Active</p>
                  </div>
                </div>
                <label className="w-full cursor-pointer flex items-center justify-center gap-2 py-2.5 rounded-xl bg-primary/10 hover:bg-primary/20 text-primary text-sm transition-colors border border-primary/20">
                  <Upload className="w-4 h-4" />Upload New PDF
                  <input type="file" className="hidden" accept=".pdf" onChange={e => { handleUpload(e); setShowSettings(false); }} disabled={isUploading||!userId} />
                </label>
                <button onClick={() => { handleNewChat(); setShowSettings(false); }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm transition-colors">
                  <Trash2 className="w-4 h-4" />Clear Chat
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
