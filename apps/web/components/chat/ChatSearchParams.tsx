'use client';

import { useSearchParams } from 'next/navigation';
import { ChatPanel } from '../ChatPanel';

export default function ChatSearchParams() {
  const searchParams = useSearchParams();
  return <ChatPanel initialConversationId={searchParams.get('c') ?? undefined} />;
}
