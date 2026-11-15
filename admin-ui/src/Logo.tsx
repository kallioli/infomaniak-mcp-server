/** Infomaniak MCP Server mark: a lowercase "k" drawn as a connector, with an AI spark (assets/favicon.svg). */
export function Logo({ size = 34, className }: { size?: number; className?: string }) {
  return <img className={className} src="/favicon.svg" width={size} height={size} alt="Infomaniak MCP Server" />;
}
