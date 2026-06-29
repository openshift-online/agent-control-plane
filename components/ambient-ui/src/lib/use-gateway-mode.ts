export function useGatewayMode(): boolean {
  return process.env.NEXT_PUBLIC_OPENSHELL_USE_GATEWAY === 'true'
}
