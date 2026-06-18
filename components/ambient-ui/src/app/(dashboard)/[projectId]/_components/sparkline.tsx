type SparklineProps = {
  data: number[]
  width?: number
  height?: number
  color?: string
  className?: string
}

export function Sparkline({
  data,
  width = 64,
  height = 20,
  color = 'currentColor',
  className,
}: SparklineProps) {
  const padding = 1.5 // half stroke width to avoid clipping

  if (data.length < 2 || data.every((v) => v === 0)) {
    const midY = height / 2
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={className}
        aria-hidden="true"
      >
        <line
          x1={padding}
          y1={midY}
          x2={width - padding}
          y2={midY}
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          opacity={0.3}
        />
      </svg>
    )
  }

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const innerWidth = width - padding * 2
  const innerHeight = height - padding * 2

  const points = data
    .map((value, i) => {
      const x = padding + (i / (data.length - 1)) * innerWidth
      const y = padding + innerHeight - ((value - min) / range) * innerHeight
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
