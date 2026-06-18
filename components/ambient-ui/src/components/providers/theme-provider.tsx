'use client'

import { useEffect } from 'react'
import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from 'next-themes'

// next-themes renders an inline <script> for FOUC prevention. React 19 warns
// about script tags inside components, but the script executes correctly during
// SSR. Suppress the false-positive until next-themes ships a fix.
// https://github.com/pacocoursey/next-themes/issues/385
function useSuppressThemeScriptWarning() {
  useEffect(() => {
    const orig = console.error
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('Encountered a script tag while rendering React component')) {
        return
      }
      orig.apply(console, args)
    }
    return () => { console.error = orig }
  }, [])
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  useSuppressThemeScriptWarning()
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
