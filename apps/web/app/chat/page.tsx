import { Suspense } from 'react';
import ChatSearchParams from '../../components/chat/ChatSearchParams';

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatSearchParams />
    </Suspense>
  );
}
