import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.scss';
import '@xyflow/react/dist/style.css';
import { AuthProvider } from '../components/AuthProvider';
import { AppShell } from '../components/AppShell';
import { ToastProvider } from '../components/Toast';
import { OfflineIndicator } from '../components/OfflineIndicator';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Smoke Monkey',
    template: '%s · Smoke Monkey',
  },
  description:
    'Smoke Monkey — a chat LLM with super memory and dynamic visual widgets. Ask questions across your PDF documents with hybrid retrieval RAG.',
  keywords: [
    'LLM',
    'chat',
    'RAG',
    'retrieval augmented generation',
    'super memory',
    'dynamic visual',
    'pgvector',
    'hybrid retrieval',
    'PDF Q&A',
  ],
  openGraph: {
    title: 'Smoke Monkey',
    description:
      'A chat LLM with super memory and dynamic visual widgets. Hybrid retrieval RAG across your documents.',
    type: 'website',
    images: ['/logo.png'],
  },
  icons: {
    icon: '/logo.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#070B10',
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.variable} ${jetbrains.variable} h-full`}>
        <OfflineIndicator />
        <ToastProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
