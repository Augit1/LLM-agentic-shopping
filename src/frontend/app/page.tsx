"use client";

import { useState, useRef, useEffect } from "react";
import ChatMessage from "@/components/ChatMessage";
import ChatInput from "@/components/ChatInput";
import ProductOptions from "@/components/ProductOptions";
import AnimatedBackground from "@/components/AnimatedBackground";
import type { Message, ProductOption } from "@/types";

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [productOptions, setProductOptions] = useState<ProductOption[] | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async (content: string) => {
    if (!content.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: content.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);
    setProductOptions(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: content.trim(),
          history: messages,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to get response");
      }

      const data = await response.json();
      
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: data.message,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);

      // Extract product options if present
      if (data.productOptions && data.productOptions.length > 0) {
        setProductOptions(data.productOptions);
      }
    } catch (error) {
      console.error("Error:", error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: "Sorry, I encountered an error. Please try again.",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectOption = async (optionIndex: number, quantity: number) => {
    const message = `Option ${optionIndex}, quantity ${quantity}`;
    await handleSendMessage(message);
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* Animated Background */}
      <AnimatedBackground />
      
      {/* Main Content */}
      <div className="relative z-10 h-full flex flex-col">
        {/* Floating Chat Container */}
        <div 
          ref={chatContainerRef}
          className="flex-1 flex flex-col mx-auto w-full max-w-4xl px-4 py-6"
        >
          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto px-2 py-4 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent">
            <div className="space-y-4">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full min-h-[60vh] text-center space-y-6">
                  <div className="relative">
                    <div className="absolute inset-0 bg-gradient-to-r from-purple-500/20 via-pink-500/20 to-blue-500/20 rounded-full blur-2xl animate-pulse" />
                    <div className="relative w-20 h-20 rounded-full glass flex items-center justify-center">
                      <svg
                        className="w-10 h-10 text-purple-600 dark:text-purple-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                        />
                      </svg>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
                      Welcome
                    </h2>
                    <p className="text-sm text-gray-600 dark:text-gray-400 max-w-md">
                      I can help you find products, compare options, and assist with checkout.
                      What would you like to search for?
                    </p>
                  </div>
                </div>
              )}

              {messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}

              {isLoading && (
                <div className="flex items-start space-x-3 animate-in fade-in slide-in-from-bottom-4 duration-300">
                  <div className="w-9 h-9 rounded-full glass flex items-center justify-center flex-shrink-0">
                    <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
                  </div>
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="flex space-x-1.5">
                      <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}

              {productOptions && productOptions.length > 0 && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <ProductOptions
                    options={productOptions}
                    onSelect={handleSelectOption}
                  />
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Floating Input Bar */}
          <div className="mt-4 mb-6">
            <div className="glass rounded-2xl p-2 shadow-2xl border border-white/20">
              <ChatInput onSend={handleSendMessage} disabled={isLoading} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

