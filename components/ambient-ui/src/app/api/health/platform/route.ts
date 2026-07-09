import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ComponentStatus = 'healthy' | 'unreachable' | 'unchecked'

type PlatformHealthResponse = {
  components: {
    apiServer: ComponentStatus
    controlPlane: ComponentStatus
  }
}

async function checkReachable(url: string): Promise<boolean> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  })
  return res.ok
}

export async function GET(): Promise<Response> {
  const apiServerUrl = `${env.API_SERVER_URL}/api/ambient`
  const controlPlaneUrl = env.CONTROL_PLANE_URL
    ? `${env.CONTROL_PLANE_URL}/healthz`
    : null

  const [apiResult, cpResult] = await Promise.allSettled([
    checkReachable(apiServerUrl),
    controlPlaneUrl ? checkReachable(controlPlaneUrl) : Promise.resolve(null),
  ])

  const apiServer: ComponentStatus =
    apiResult.status === 'fulfilled' && apiResult.value ? 'healthy' : 'unreachable'

  let controlPlane: ComponentStatus
  if (cpResult.status === 'fulfilled' && cpResult.value === null) {
    controlPlane = 'unchecked'
  } else if (cpResult.status === 'fulfilled' && cpResult.value) {
    controlPlane = 'healthy'
  } else {
    controlPlane = 'unreachable'
  }

  const body: PlatformHealthResponse = {
    components: { apiServer, controlPlane },
  }

  return Response.json(body)
}
