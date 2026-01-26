"use client";

import { useState } from "react";
import type { ProductOption } from "@/types";

interface ProductOptionsProps {
  options: ProductOption[];
  onSelect: (optionIndex: number, quantity: number) => void;
}

export default function ProductOptions({ options, onSelect }: ProductOptionsProps) {
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [quantities, setQuantities] = useState<Record<number, number>>({});

  const handleQuantityChange = (optionIndex: number, quantity: number) => {
    setQuantities((prev) => ({ ...prev, [optionIndex]: quantity }));
  };

  const handleSelect = (optionIndex: number) => {
    const quantity = quantities[optionIndex] || 1;
    onSelect(optionIndex, quantity);
    setSelectedOption(null);
    setQuantities({});
  };

  return (
    <div className="space-y-5">
      <h3 className="text-xl font-semibold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
        Product Options
      </h3>
      <div className="grid gap-4 md:grid-cols-2">
        {options.map((option, idx) => (
          <div
            key={option.option_index}
            className="glass rounded-2xl p-6 shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-[1.02] border border-white/20 animate-in fade-in slide-in-from-bottom-4"
            style={{ animationDelay: `${idx * 100}ms` }}
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1">
                <h4 className="font-semibold text-lg mb-2 text-gray-900 dark:text-gray-100">
                  {option.title}
                </h4>
                <p className="text-xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
                  {option.price} {option.currency || ""}
                </p>
              </div>
              <span className="text-xs font-semibold text-purple-600 dark:text-purple-400 bg-purple-100/50 dark:bg-purple-900/30 px-3 py-1.5 rounded-full">
                Option {option.option_index}
              </span>
            </div>

            {option.bullets && option.bullets.length > 0 && (
              <ul className="space-y-2 mb-5">
                {option.bullets.map((bullet, idx) => (
                  <li key={idx} className="text-sm text-gray-600 dark:text-gray-300 flex items-start">
                    <span className="mr-2 text-purple-500">•</span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            )}

            {option.seller && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                Seller: <span className="font-medium">{option.seller}</span>
              </p>
            )}

            <div className="flex items-center space-x-3 pt-4 border-t border-white/10">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Quantity:
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={quantities[option.option_index] || 1}
                onChange={(e) =>
                  handleQuantityChange(option.option_index, parseInt(e.target.value) || 1)
                }
                className="w-20 rounded-lg border border-white/30 bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:border-purple-500/50 transition-all"
              />
              <button
                onClick={() => handleSelect(option.option_index)}
                className="flex-1 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white px-4 py-2.5 text-sm font-semibold hover:from-purple-600 hover:to-pink-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50 transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-105 active:scale-95"
              >
                Select
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

