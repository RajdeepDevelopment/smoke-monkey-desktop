/** Scrollable content wrapper for standard pages (not full-height views like Chat). */
export function PageScroll({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-4 py-5 sm:py-6">{children}</div>
    </div>
  );
}
