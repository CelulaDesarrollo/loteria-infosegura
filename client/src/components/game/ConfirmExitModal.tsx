"use client";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface ConfirmExitModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmExitModal({ open, onClose, onConfirm }: ConfirmExitModalProps) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="max-w-sm w-[90vw] pt-4 px-6 pb-6">
        <AlertDialogCancel asChild>
          <button
            className="
              absolute top-3 right-3 rounded-full p-1.5
              bg-[#165C5D] hover:bg-[#1E7374] border border-gray-200
              shadow-sm transition-all duration-200 w-7 h-7 flex items-center justify-center
            "
            aria-label="Cerrar"
            onClick={onClose}
          >
            <X className="w-4 h-4 text-[#00000] hover:text-gray-700" />
          </button>
        </AlertDialogCancel>

        <AlertDialogHeader className="mt-6">
          <AlertDialogTitle className="text-lg font-semibold text-center">
            ¿Salir de la sala?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-center text-sm text-muted-foreground mt-2">
            Si sales de la sala perderás la conexión y tu progreso en el juego. ¿Estás seguro de que deseas salir?
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter className="mt-6">
          {/* responsive: column on small screens, row on sm+ */}
          <div className="w-full flex flex-col sm:flex-row gap-3">
            <AlertDialogCancel asChild>
              <button
                onClick={onClose}
                className="w-full sm:w-[48%] px-3 py-2 rounded-md bg-gray-100 text-gray-800"
              >
                Cancelar
              </button>
            </AlertDialogCancel>

            <Button
              onClick={onConfirm}
              className="w-full sm:w-[48%] bg-[#D4165C] hover:bg-[#AA124A] text-white"
            >
              Salir
            </Button>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}