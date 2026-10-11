/**
 * Delta-V mark — bold double-chevron `>>`, traced from the approved
 * AI-generated masters (assets/production/DeltaV-icon-*).
 * Uses currentColor so badges control light/dark treatment.
 */
export function SpawnMark({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={(size * 40) / 58}
      viewBox="0 0 58 40"
      fill="currentColor"
      aria-label="Delta-V"
    >
      <polygon points="8,8 18,8 32,20 18,32 8,32 22,20" />
      <polygon points="26,8 36,8 50,20 36,32 26,32 40,20" />
    </svg>
  )
}
