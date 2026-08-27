'use client';

interface BrandIconProps {
  size?: number;
  className?: string;
}

/** The Smoke Monkey brand logo, sized in px so every call site stays consistent. */
export function BrandIcon({ size = 32, className }: BrandIconProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.png"
      alt="Smoke Monkey"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`shrink-0 object-contain ${className ?? ''}`}
    />
  );
}
