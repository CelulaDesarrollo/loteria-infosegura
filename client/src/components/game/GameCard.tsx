"use client";

import Image from "next/image";
import { Card } from "@/lib/loteria";
import { useState } from "react";

interface GameCardProps {
  card: Card;
  index: number;
  isMarked: boolean;
  onCardClick: (index: number, cardId: string) => void;
  isAllowed: boolean;
}

export function GameCard({
  card,
  index,
  isMarked,
  onCardClick,
  isAllowed,
}: GameCardProps) {
  const [isProcessing, setIsProcessing] = useState(false);

  const handleClick = async () => {
    if (!isAllowed || isProcessing) return;

    setIsProcessing(true);
    try {
      // card.id puede ser string o number, normalizar a string
      const cardId = String(card.id || index);
      await onCardClick(index, cardId);
    } catch (err) {
      console.error("Error al marcar carta:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`
        relative cursor-pointer transition-all duration-200
        ${isMarked ? "ring-4 ring-yellow-400 scale-105" : "hover:scale-102"}
        ${!isAllowed ? "opacity-50 cursor-not-allowed" : ""}
        ${isProcessing ? "pointer-events-none opacity-75" : ""}
      `}
    >
      <img
        src={card.imageUrl}
        alt={card.name}
        className="w-full h-full object-cover rounded"
      />

      {/* Frijolito (marcador visual) */}
      {isMarked && (
        <div className="absolute top-1 right-1 w-4 h-4 bg-yellow-400 rounded-full border-2 border-yellow-600 shadow-lg" />
      )}
    </div>
  );
}
