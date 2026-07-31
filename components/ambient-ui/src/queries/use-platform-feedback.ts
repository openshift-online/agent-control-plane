'use client'

import { useQuery, useMutation } from '@tanstack/react-query'

type FeedbackAvailability = {
  available: boolean
}

type FeedbackSubmission = {
  text: string
  pagePath: string
}

type FeedbackResult = {
  success: boolean
}

export function useFeedbackAvailability() {
  return useQuery<FeedbackAvailability>({
    queryKey: ['platform-feedback', 'availability'],
    queryFn: async () => {
      const res = await fetch('/api/feedback')
      if (!res.ok) {
        return { available: false }
      }
      return res.json() as Promise<FeedbackAvailability>
    },
    staleTime: 5 * 60_000,
  })
}

export function useSubmitPlatformFeedback() {
  return useMutation<FeedbackResult, Error, FeedbackSubmission>({
    mutationFn: async (submission) => {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as Record<string, unknown>
        throw new Error(typeof body.error === 'string' ? body.error : 'Failed to send feedback')
      }

      return res.json() as Promise<FeedbackResult>
    },
  })
}
