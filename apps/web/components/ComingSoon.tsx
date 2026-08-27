import Link from 'next/link';

export default function ComingSoon({ title }: { title: string }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="max-w-md text-sm text-ink-secondary">
        This workspace is under construction. Chat and Knowledge Base are available today.
      </p>
      <Link href="/chat" className="btn-primary mt-2">
        Go to Chat
      </Link>
    </div>
  );
}
