import React, { Suspense } from 'react';

// La función generateStaticParams sigue aquí (es Server)
export async function generateStaticParams() {
  return [
    { id: 'main_loteria' },
  ];
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