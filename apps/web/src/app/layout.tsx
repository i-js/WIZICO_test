import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Список дел — совместные задачи',
  description: 'Список задач для двоих с синхронизацией и офлайн-очередью',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
