import type { Metadata } from 'next';
import { Suspense } from 'react';
import './globals.css'
import React from 'react';

export const metadata: Metadata = {
  title: 'Lotería - InfoSegura',
  description: 'Elaborado por Célula de Desarrollo de Contenidos DGTI Xalapa.',
  icons: {
    icon: '/uv.png',
    apple: '/uv.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <head>
        {/* Fallback explícito */}
        <link rel="icon" href="/uv.png" />
        <link rel="apple-touch-icon" href="/uv.png" />
        <meta name="theme-color" content="#005eb8" />
      </head>
      <body>{children}</body>
    </html>
  );
}
