import React from 'react';

// 🚨 La función generateStaticParams va AQUÍ, en el archivo de servidor.
export async function generateStaticParams() {
  // Generamos la única sala que necesitamos para la URL estática
  return [
    { id: 'main_loteria' },
  ];
}

interface LayoutProps {
  children: React.ReactNode;
}

// Este Layout es un componente de Servidor por defecto.
export default function RoomLayout({ children }: LayoutProps) {
  // Simplemente renderiza el componente de página que está dentro
  return (
    <>{children}</>
  );
}