'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, Send, Upload, FileText, Settings, History, MessageSquare, Sparkles } from 'lucide-react';
import VoiceVisualizer from '@/components/VoiceVisualizer';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function EchoPDF() {
  const [messages, setMessages] = useState<{ role: 'user' | 'ai'; content: string }[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [input, setInput] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('http://localhost:8000/upload_pdf', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      setFilename(data.filename);
      setMessages([...messages, { role: 'ai', content: `Uploaded ${data.filename}. I'm ready to chat!` }]);
    } catch (err) {
      console.error(err);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMsg = input;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }]);

    try {
      const formData = new FormData();
      formData.append('text_query', userMsg);
      if (filename) formData.append('filename', filename);

      const res = await fetch('http://localhost:8000/chat_stream', {
        method: 'POST',
        body: formData,
      });

      const reader = res.body?.getReader();
      if (!reader) return;

      setMessages((prev) => [...prev, { role: 'ai', content: '' }]);
      
      let aiResponse = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = new TextDecoder().decode(value);
        aiResponse += chunk;
        setMessages((prev) => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].content = aiResponse;
          return newMessages;
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <main className="flex h-screen w-full bg-transparent overflow-hidden font-inter">
      {/* Sidebar */}
      <aside className="w-64 glass border-r border-white/10 flex flex-col p-4 z-10">
        <div className="flex items-center gap-2 mb-8 px-2">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(188,19,254,0.5)]">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold font-outfit tracking-tight">EchoPDF</h1>
        </div>

        <nav className="flex-1 space-y-2">
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors text-sm">
            <MessageSquare className="w-4 h-4 text-neon-blue" />
            <span>New Chat</span>
          </button>
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/5 transition-colors text-sm text-gray-400">
            <History className="w-4 h-4" />
            <span>History</span>
          </button>
        </nav>

        <div className="mt-auto space-y-2">
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/5 transition-colors text-sm text-gray-400">
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <section className="flex-1 flex flex-col relative">
        {/* Background Mesh (Optional/Extra) */}
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-neon-purple blur-[120px] rounded-full" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-neon-blue blur-[120px] rounded-full" />
        </div>

        {/* Header */}
        <header className="h-16 flex items-center justify-between px-8 z-10">
          <div className="flex items-center gap-4">
            {filename && (
              <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/10 text-xs">
                <FileText className="w-3.5 h-3.5 text-neon-blue" />
                <span className="max-w-[150px] truncate">{filename}</span>
              </div>
            )}
          </div>
        </header>

        {/* Chat Area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-4 space-y-6 z-10 scroll-smooth">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="max-w-md"
              >
                <div className="w-20 h-20 bg-white/5 rounded-3xl flex items-center justify-center mb-6 mx-auto border border-white/10">
                  <Upload className="w-10 h-10 text-gray-400" />
                </div>
                <h2 className="text-3xl font-bold font-outfit mb-4">Start your conversation</h2>
                <p className="text-gray-400 mb-8">Upload a PDF and start asking questions using voice or text. We'll handle the rest.</p>
                <label className="cursor-pointer bg-primary hover:bg-primary/80 text-white px-8 py-3 rounded-2xl font-semibold transition-all shadow-[0_0_20px_rgba(188,19,254,0.3)]">
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
                    "flex flex-col max-w-[80%]",
                    msg.role === 'user' ? "ml-auto items-end" : "mr-auto items-start"
                  )}
                >
                  <div className={cn(
                    "px-4 py-3 rounded-2xl text-sm leading-relaxed",
                    msg.role === 'user' 
                      ? "bg-primary text-white shadow-[0_4px_15px_rgba(188,19,254,0.2)]" 
                      : "glass border-white/5 text-gray-100"
                  )}>
                    {msg.content}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>

        {/* Input Area */}
        <footer className="p-8 z-10">
          <div className="max-w-4xl mx-auto relative">
            <div className="glass rounded-3xl p-2 flex items-center gap-2 border border-white/10 shadow-2xl focus-within:border-primary/50 transition-all">
              <button
                onClick={() => setIsRecording(!isRecording)}
                className={cn(
                  "w-12 h-12 rounded-2xl flex items-center justify-center transition-all",
                  isRecording ? "bg-red-500/20 text-red-400" : "hover:bg-white/5 text-gray-400"
                )}
              >
                <Mic className={cn("w-6 h-6", isRecording && "animate-pulse")} />
              </button>
              
              <div className="flex-1 relative">
                {isRecording ? (
                  <VoiceVisualizer isRecording={isRecording} />
                ) : (
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                    placeholder="Ask anything about the PDF..."
                    className="w-full bg-transparent border-none outline-none px-4 py-3 text-sm placeholder:text-gray-500"
                  />
                )}
              </div>

              <button
                onClick={handleSend}
                disabled={!input.trim() || isRecording}
                className="w-12 h-12 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-neon-blue rounded-2xl flex items-center justify-center transition-all border border-white/10"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
        </footer>
      </section>
    </main>
  );
}
