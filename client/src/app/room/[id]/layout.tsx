import React, { Suspense } from 'react';

// La función generateStaticParams sigue aquí (es Server)
export async function generateStaticParams() {
  // generar estáticamente 4 salas (puedes cambiar los ids a 'sala-1' / 'sala-2' ...)
  const ROOM_IDS = ["main_loteria-1", "main_loteria-2", "main_loteria-3", "main_loteria-4"];
  return ROOM_IDS.map((id) => ({ id }));
}

interface LayoutProps {
  children: React.ReactNode;
}

// Este Layout es un componente de Servidor por defecto.
export default function RoomLayout({ children }: LayoutProps) {
  return (
    // 🚨 Agregamos <Suspense> para manejar el useSearchParams() de RoomPage
    // Este fallback solo aparecerá durante la precarga estática
    <Suspense fallback={<div>Cargando juego...</div>}>
      {children}
    </Suspense>
  );
}