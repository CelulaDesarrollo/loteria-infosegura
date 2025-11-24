"use client";

import { Card as CardType } from "@/lib/loteria";
import { GameCard } from "./GameCard";

interface GameBoardProps {
  board: CardType[];
  onCardClick: (index: number, cardId: string) => Promise<void>;
  markedIndices: number[];
  calledCardIds: string[];
  isAllowed: (card: { row: number; col: number }) => boolean;
}

export function GameBoard({
  board,
  onCardClick,
  markedIndices,
  calledCardIds,
  isAllowed,
}: GameBoardProps) {
  const seleccionadas = markedIndices.length;

  return (
    <div className="w-full h-full">
      {board.map((card, index) => {
        const row = Math.floor(index / 4);
        const col = index % 4;
        const isMarked = markedIndices.includes(index);
        const isCalled = calledCardIds.includes(String(card.id));
        const isCardAllowed = isAllowed({ row, col });

        return (
          <GameCard
            key={index}
            card={card}
            index={index}
            isMarked={isMarked}
            onCardClick={(idx, cardId) => onCardClick(idx, cardId)}
            isAllowed={isCardAllowed}
          />
        );
      })}
    </div>
  );
}
