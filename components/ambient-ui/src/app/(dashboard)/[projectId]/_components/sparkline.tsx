type SparklineProps = {
  data: number[]
  height?: number
  color?: string
  className?: string
}

const VIEWBOX_WIDTH = 200
const VIEWBOX_HEIGHT = 28
const STROKE_WIDTH = 1.5
const MIN_RANGE = 2 // avoid flat-line spikes when all values are nearly equal

export function Sparkline({
  data,
  height = 28,
  color = 'currentColor',
  className,
}: SparklineProps) {
  const padding = STROKE_WIDTH // avoid clipping at edges

  if (data.length < 2 || data.every((v) => v === 0)) {
    const midY = VIEWBOX_HEIGHT / 2
    return (
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        className={className}
        aria-hidden="true"
      >
        <line
          x1={padding}
          y1={midY}
          x2={VIEWBOX_WIDTH - padding}
          y2={midY}
          stroke={color}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          opacity={0.3}
        />
      </svg>
    )
  }

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = Math.max(max - min, MIN_RANGE)

  const innerWidth = VIEWBOX_WIDTH - padding * 2
  const innerHeight = VIEWBOX_HEIGHT - padding * 2

  const coords = data.map((value, i) => {
    const x = padding + (i / (data.length - 1)) * innerWidth
    const y = padding + innerHeight - ((value - min) / range) * innerHeight
    return { x, y }
  })

  const linePoints = coords.map(({ x, y }) => `${x},${y}`).join(' ')

  // Build a closed polygon for the area fill: line points + bottom-right + bottom-left
  const areaPath = [
    ...coords.map(({ x, y }) => `${x},${y}`),
    `${coords[coords.length - 1].x},${VIEWBOX_HEIGHT}`,
    `${coords[0].x},${VIEWBOX_HEIGHT}`,
  ].join(' ')

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      <polygon
        points={areaPath}
        fill={color}
        opacity={0.1}
      />
      <polyline
        points={linePoints}
        fill="none"
        stroke={color}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
