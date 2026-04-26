'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mic, Send, Upload, FileText, Settings, History, MessageSquare,
  Sparkles, X, Menu, Trash2, Info, Volume2, VolumeX, BookOpen,
} from 'lucide-react';
import VoiceVisualizer from '@/components/VoiceVisualizer';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Message = {
  role: 'user' | 'ai';
  content: string;
  citations?: number[];
  suggestions?: string[];
};

const CITATION_MARKER = '\n[CITATIONS]';

export default function EchoPDF() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [input, setInput] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const [voiceReply, setVoiceReply] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ── TTS helpers ─────────────────────────────────────────────────────────────
  const stripMarkdown = (text: string) =>
    text
      .replace(/#{1,6}\s/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`{1,3}[^`]*`{1,3}/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^\s*[-*+]\s/gm, '')
      .replace(/^\s*\d+\.\s/gm, '')
      .replace(/>/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .trim();

  const speak = (text: string) => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(stripMarkdown(text));
    utterance.rate = 1;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  };

  // ── Conversation history builder ─────────────────────────────────────────────
  const buildHistory = (msgs: Message[]) =>
    msgs
      .filter(m => m.content && !m.content.startsWith('🎤 Transcri'))
      .map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }));

  // ── Streaming AI response (shared by text + voice paths) ────────────────────
  const streamAiResponse = async (formData: FormData) => {
    setIsStreaming(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/chat_stream`, {
        method: 'POST',
        body: formData,
      });
      const reader = res.body?.getReader();
      if (!reader) return;

      setMessages(prev => [...prev, { role: 'ai', content: '' }]);
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += new TextDecoder().decode(value);
        const displayText = accumulated.split(CITATION_MARKER)[0];
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { ...updated[updated.length - 1], content: displayText };
          return updated;
        });
      }

      const citationIdx = accumulated.indexOf(CITATION_MARKER);
      let citations: number[] = [];
      if (citationIdx !== -1) {
        try { citations = JSON.parse(accumulated.slice(citationIdx + CITATION_MARKER.length)); }
        catch { /* ignore malformed */ }
      }
      const cleanContent = citationIdx !== -1 ? accumulated.slice(0, citationIdx) : accumulated;

      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'ai', content: cleanContent, citations };
        return updated;
      });

      if (voiceReply && cleanContent) speak(cleanContent);
    } finally {
      setIsStreaming(false);
    }
  };

  // ── Upload PDF ───────────────────────────────────────────────────────────────
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/upload_pdf`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      const name: string = data.filename ?? file.name;
      setFilename(name);
      const uploadMsg: Message = {
        role: 'ai',
        content: data.summary
          ? `**"${name}" uploaded successfully.**\n\n${data.summary}`
          : `Uploaded **"${name}"**. I'm ready to answer your questions!`,
        suggestions: Array.isArray(data.questions) ? data.questions : [],
      };
      setMessages(prev => [...prev, uploadMsg]);
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, { role: 'ai', content: 'Upload failed. Please try again.' }]);
    } finally {
      setIsUploading(false);
    }
  };

  // ── Send text message ────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;
    const userMsg = input;
    setInput('');
    const history = buildHistory(messages);
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    try {
      const formData = new FormData();
      formData.append('text_query', userMsg);
      if (filename) formData.append('filename', filename);
      formData.append('history', JSON.stringify(history));
      await streamAiResponse(formData);
    } catch (err) {
      console.error(err);
    }
  };

  // ── Send a suggested question directly ──────────────────────────────────────
  const handleSuggestion = async (question: string) => {
    if (isStreaming) return;
    const history = buildHistory(messages);
    setMessages(prev => [...prev, { role: 'user', content: question }]);
    try {
      const formData = new FormData();
      formData.append('text_query', question);
      if (filename) formData.append('filename', filename);
      formData.append('history', JSON.stringify(history));
      await streamAiResponse(formData);
    } catch (err) {
      console.error(err);
    }
  };

  // ── Voice recording ──────────────────────────────────────────────────────────
  const handleMicClick = async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    const historySnapshot = buildHistory(messages); // capture before recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setIsRecording(false);
        setIsProcessingVoice(true);
        setMessages(prev => [...prev, { role: 'user', content: '🎤 Transcribing…' }]);
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

          const transcribeForm = new FormData();
          transcribeForm.append('audio', audioBlob, 'recording.webm');
          const transcribeRes = await fetch(
            `${process.env.NEXT_PUBLIC_BACKEND_URL}/transcribe`,
            { method: 'POST', body: transcribeForm }
          );
          const { text } = await transcribeRes.json();

          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'user', content: text };
            return updated;
          });

          const chatForm = new FormData();
          chatForm.append('text_query', text);
          if (filename) chatForm.append('filename', filename);
          chatForm.append('history', JSON.stringify(historySnapshot));
          await streamAiResponse(chatForm);
        } catch (err) {
          console.error(err);
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'user', content: '🎤 Transcription failed' };
            return updated;
          });
        } finally {
          setIsProcessingVoice(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      alert('Microphone access denied. Please allow microphone access in your browser.');
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setFilename(null);
    setSidebarOpen(false);
    window.speechSynthesis.cancel();
  };

  const userMessages = messages.filter(m => m.role === 'user');

  return (
    <main className="flex h-screen w-full bg-transparent overflow-hidden font-inter">

      {/* Mobile sidebar backdrop */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 bg-black/60 z-20 md:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className={cn(
        "fixed md:relative top-0 left-0 h-full w-64 glass border-r border-white/10 flex flex-col p-4 z-30 transition-transform duration-300",
        "md:translate-x-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex items-center justify-between mb-8 px-2">
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

        <nav className="flex-1 space-y-2">
          <button
            onClick={handleNewChat}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors text-sm"
          >
            <MessageSquare className="w-4 h-4 text-neon-blue" />
            <span>New Chat</span>
          </button>
          <button
            onClick={() => { setShowHistory(true); setSidebarOpen(false); }}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/5 transition-colors text-sm text-gray-400"
          >
            <History className="w-4 h-4" />
            <span>History</span>
            {userMessages.length > 0 && (
              <span className="ml-auto text-xs bg-primary/30 text-primary px-2 py-0.5 rounded-full">
                {userMessages.length}
              </span>
            )}
          </button>
        </nav>

        <div className="mt-auto space-y-2">
          {filename && (
            <div className="flex items-center gap-2 bg-white/5 px-3 py-2 rounded-xl border border-white/10 text-xs text-gray-400">
              <FileText className="w-3.5 h-3.5 text-neon-blue shrink-0" />
              <span className="truncate">{filename}</span>
            </div>
          )}
          <button
            onClick={() => { setShowSettings(true); setSidebarOpen(false); }}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/5 transition-colors text-sm text-gray-400"
          >
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
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
            {filename ? (
              <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/10 text-xs">
                <FileText className="w-3.5 h-3.5 text-neon-blue shrink-0" />
                <span className="max-w-[120px] md:max-w-[200px] truncate">{filename}</span>
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
          <label className="cursor-pointer flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-xl text-xs transition-all">
            <Upload className="w-3.5 h-3.5 text-neon-blue" />
            <span>{isUploading ? 'Indexing...' : filename ? 'Change PDF' : 'Upload PDF'}</span>
            <input type="file" className="hidden" accept=".pdf" onChange={handleUpload} disabled={isUploading} />
          </label>
        </header>

        {/* Chat Area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-8 py-4 space-y-4 z-10 scroll-smooth">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-4">
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm w-full">
                <div className="w-16 h-16 md:w-20 md:h-20 bg-white/5 rounded-3xl flex items-center justify-center mb-5 mx-auto border border-white/10">
                  <Upload className="w-8 h-8 md:w-10 md:h-10 text-gray-400" />
                </div>
                <h2 className="text-2xl md:text-3xl font-bold font-outfit mb-3">Start your conversation</h2>
                <p className="text-gray-400 text-sm mb-7">Upload a PDF and ask questions using voice or text.</p>
                <label className="cursor-pointer inline-block bg-primary hover:bg-primary/80 text-white px-8 py-3 rounded-2xl font-semibold transition-all shadow-[0_0_20px_rgba(188,19,254,0.3)] text-sm">
                  {isUploading ? 'Indexing...' : 'Upload PDF'}
                  <input type="file" className="hidden" accept=".pdf" onChange={handleUpload} disabled={isUploading} />
                </label>
              </motion.div>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {messages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: msg.role === 'user' ? 20 : -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={cn(
                    "flex flex-col max-w-[85%] md:max-w-[75%]",
                    msg.role === 'user' ? "ml-auto items-end" : "mr-auto items-start"
                  )}
                >
                  {/* Message bubble */}
                  <div className={cn(
                    "px-4 py-3 rounded-2xl text-sm leading-relaxed",
                    msg.role === 'user'
                      ? "bg-primary text-white shadow-[0_4px_15px_rgba(188,19,254,0.2)]"
                      : "glass border border-white/5 text-gray-100"
                  )}>
                    {msg.role === 'ai'
                      ? msg.content
                        ? <MarkdownRenderer content={msg.content} />
                        : <span className="animate-pulse text-gray-500">Thinking...</span>
                      : msg.content
                    }
                  </div>

                  {/* Citations */}
                  {msg.role === 'ai' && msg.citations && msg.citations.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1.5 px-1 flex-wrap">
                      <BookOpen className="w-3 h-3 text-gray-500" />
                      <span className="text-xs text-gray-500">Sources:</span>
                      {msg.citations.map(page => (
                        <span
                          key={page}
                          className="text-xs bg-neon-blue/10 text-neon-blue border border-neon-blue/20 px-2 py-0.5 rounded-full"
                        >
                          Page {page}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Suggested questions (shown under upload message) */}
                  {msg.role === 'ai' && msg.suggestions && msg.suggestions.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5 w-full">
                      {msg.suggestions.map((q, qi) => (
                        <button
                          key={qi}
                          onClick={() => handleSuggestion(q)}
                          disabled={isStreaming}
                          className="text-xs text-left bg-white/5 hover:bg-white/10 border border-white/10 hover:border-primary/30 px-3 py-2 rounded-xl text-gray-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
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

        {/* Input Area */}
        <footer className="p-3 md:p-6 z-10">
          <div className="max-w-3xl mx-auto">
            <div className="glass rounded-2xl p-2 flex items-center gap-2 border border-white/10 shadow-2xl focus-within:border-primary/50 transition-all">
              <button
                onClick={handleMicClick}
                disabled={isProcessingVoice || isStreaming}
                className={cn(
                  "w-10 h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center transition-all shrink-0",
                  isRecording ? "bg-red-500/20 text-red-400" : "hover:bg-white/5 text-gray-400",
                  isProcessingVoice && "opacity-40 cursor-not-allowed"
                )}
              >
                <Mic className={cn("w-5 h-5", (isRecording || isProcessingVoice) && "animate-pulse")} />
              </button>

              <div className="flex-1 min-w-0">
                {isRecording ? (
                  <VoiceVisualizer isRecording={isRecording} />
                ) : isProcessingVoice ? (
                  <span className="px-2 text-sm text-gray-400 animate-pulse">Transcribing voice...</span>
                ) : (
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                    placeholder="Ask anything about the PDF..."
                    className="w-full bg-transparent border-none outline-none px-2 py-2 text-sm placeholder:text-gray-500"
                  />
                )}
              </div>

              <button
                onClick={() => { setVoiceReply(v => !v); window.speechSynthesis.cancel(); }}
                title={voiceReply ? 'Voice reply on' : 'Voice reply off'}
                className={cn(
                  "w-10 h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center transition-all shrink-0",
                  voiceReply ? "bg-neon-blue/20 text-neon-blue" : "hover:bg-white/5 text-gray-500"
                )}
              >
                {voiceReply
                  ? <Volume2 className="w-4 h-4 md:w-5 md:h-5" />
                  : <VolumeX className="w-4 h-4 md:w-5 md:h-5" />}
              </button>

              <button
                onClick={handleSend}
                disabled={!input.trim() || isRecording || isStreaming}
                className="w-10 h-10 md:w-12 md:h-12 bg-primary/20 hover:bg-primary/40 disabled:opacity-30 text-neon-blue rounded-xl flex items-center justify-center transition-all shrink-0"
              >
                <Send className="w-4 h-4 md:w-5 md:h-5" />
              </button>
            </div>
          </div>
        </footer>
      </section>

      {/* History Modal */}
      <AnimatePresence>
        {showHistory && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setShowHistory(false)}
            className="fixed inset-0 bg-black/60 z-40 flex items-end md:items-center justify-center p-4"
          >
            <motion.div
              initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 50, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="glass border border-white/10 rounded-2xl w-full max-w-md max-h-[70vh] flex flex-col overflow-hidden"
            >
              <div className="flex items-center justify-between p-4 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-neon-blue" />
                  <h2 className="font-semibold text-sm">Chat History</h2>
                </div>
                <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {userMessages.length === 0 ? (
                  <div className="text-center text-gray-500 text-sm py-8">
                    <History className="w-8 h-8 mx-auto mb-3 opacity-30" />
                    <p>No messages yet</p>
                    <p className="text-xs mt-1">Your questions will appear here</p>
                  </div>
                ) : (
                  userMessages.map((msg, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/8 transition-colors">
                      <span className="text-xs text-primary font-semibold shrink-0 mt-0.5">Q{i + 1}</span>
                      <p className="text-sm text-gray-300 line-clamp-2">{msg.content}</p>
                    </div>
                  ))
                )}
              </div>
              {userMessages.length > 0 && (
                <div className="p-4 border-t border-white/10">
                  <button
                    onClick={() => { handleNewChat(); setShowHistory(false); }}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                    Clear Chat
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
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setShowSettings(false)}
            className="fixed inset-0 bg-black/60 z-40 flex items-end md:items-center justify-center p-4"
          >
            <motion.div
              initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 50, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="glass border border-white/10 rounded-2xl w-full max-w-md overflow-hidden"
            >
              <div className="flex items-center justify-between p-4 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <Settings className="w-4 h-4 text-neon-blue" />
                  <h2 className="font-semibold text-sm">Settings</h2>
                </div>
                <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                  <p className="text-xs text-gray-500 mb-1">Active PDF</p>
                  {filename ? (
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-neon-blue shrink-0" />
                      <p className="text-sm truncate">{filename}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">No PDF uploaded</p>
                  )}
                </div>
                <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                  <div className="flex items-center gap-2 mb-1">
                    <Info className="w-3.5 h-3.5 text-gray-500" />
                    <p className="text-xs text-gray-500">Backend</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]" />
                    <p className="text-xs text-gray-400 truncate">HuggingFace Space · Active</p>
                  </div>
                </div>
                <label className="w-full cursor-pointer flex items-center justify-center gap-2 py-2.5 rounded-xl bg-primary/10 hover:bg-primary/20 text-primary text-sm transition-colors border border-primary/20">
                  <Upload className="w-4 h-4" />
                  Upload New PDF
                  <input type="file" className="hidden" accept=".pdf" onChange={(e) => { handleUpload(e); setShowSettings(false); }} disabled={isUploading} />
                </label>
                <button
                  onClick={() => { handleNewChat(); setShowSettings(false); }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Clear Chat
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
