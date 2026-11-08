import { useId } from "react";

/** Infomaniak MCP Server mark: a lowercase "k" drawn as a connector, with an AI spark. Same as assets/favicon.svg. */
export function Logo({ size = 34, className }: { size?: number; className?: string }) {
  const gradient = useId();
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Infomaniak MCP Server">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0098FF" />
          <stop offset="1" stopColor="#5B4BFF" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${gradient})`} />
      <path d="M21 13 V51" stroke="#fff" strokeWidth="7" strokeLinecap="round" fill="none" />
      <path d="M22.5 37 L38 25" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" fill="none" />
      <path d="M29 33 L40 46" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" fill="none" />
      <circle cx="40" cy="23.5" r="5" fill="#fff" />
      <circle cx="41.5" cy="47.5" r="5" fill="#fff" />
      <path d="M51 7 L52.9 12.1 L58 14 L52.9 15.9 L51 21 L49.1 15.9 L44 14 L49.1 12.1 Z" fill="#fff" />
    </svg>
  );
}
