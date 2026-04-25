'use client';

import { motion } from 'framer-motion';

export default function VoiceVisualizer({ isRecording }: { isRecording: boolean }) {
  return (
    <div className="flex items-center justify-center gap-1 h-12">
      {[...Array(5)].map((_, i) => (
        <motion.div
          key={i}
          animate={
            isRecording
              ? {
                  height: [12, 40, 12],
                }
              : {
                  height: 4,
                }
          }
          transition={{
            duration: 0.6,
            repeat: Infinity,
            delay: i * 0.1,
          }}
          className="w-1 bg-neon-blue rounded-full shadow-[0_0_10px_rgba(0,243,255,0.5)]"
        />
      ))}
    </div>
  );
}
