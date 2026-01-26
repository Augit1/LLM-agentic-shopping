"use client";

import type { Message } from "@/types";
import { format } from "date-fns";

interface ChatMessageProps {
  message: Message;
}

export default function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div 
      className={`flex items-start space-x-3 animate-in fade-in slide-in-from-bottom-4 duration-300 ${
        isUser ? "flex-row-reverse space-x-reverse" : ""
      }`}
    >
      <div
        className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 glass ${
          isUser
            ? "bg-gradient-to-br from-purple-500 to-pink-500"
            : "bg-gradient-to-br from-blue-500 to-cyan-500"
        }`}
      >
        {isUser ? (
          <svg
            className="w-5 h-5 text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
            />
          </svg>
        ) : (
          <svg
            className="w-5 h-5 text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
        )}
      </div>
      <div className={`flex-1 ${isUser ? "text-right" : ""}`}>
        <div
          className={`inline-block rounded-2xl px-4 py-3 max-w-[85%] glass ${
            isUser
              ? "bg-gradient-to-br from-purple-500/90 to-pink-500/90 text-white"
              : "bg-white/80 dark:bg-gray-800/80 text-gray-900 dark:text-gray-100"
          } shadow-lg`}
        >
          <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
            {message.content}
          </p>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 px-2">
          {format(message.timestamp, "HH:mm")}
        </p>
      </div>
    </div>
  );
}

