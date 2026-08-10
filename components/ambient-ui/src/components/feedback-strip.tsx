'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { MessageSquareText, Loader2, CheckCircle2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  useFeedbackAvailability,
  useSubmitPlatformFeedback,
} from '@/queries/use-platform-feedback'

type FeedbackState = 'idle' | 'submitting' | 'success' | 'error'

export function FeedbackStrip() {
  const { data: availability } = useFeedbackAvailability()
  const submitMutation = useSubmitPlatformFeedback()
  const pathname = usePathname()

  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [state, setState] = useState<FeedbackState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resetDialog = useCallback(() => {
    setText('')
    setState('idle')
    setErrorMessage('')
  }, [])

  useEffect(() => {
    if (open && state === 'idle') {
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [open, state])

  useEffect(() => {
    if (state === 'success') {
      const timer = setTimeout(() => {
        setOpen(false)
        resetDialog()
      }, 2500)
      return () => clearTimeout(timer)
    }
  }, [state, resetDialog])

  if (!availability?.available) {
    return null
  }

  const canSubmit = text.trim().length > 0 && state === 'idle'

  function handleSubmit() {
    if (!canSubmit) return

    setState('submitting')
    submitMutation.mutate(
      { text: text.trim(), pagePath: pathname },
      {
        onSuccess: () => setState('success'),
        onError: (err) => {
          setState('error')
          setErrorMessage(err.message || 'Something went wrong. Please try again.')
        },
      }
    )
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      resetDialog()
    }
  }

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        className="fixed right-0 top-1/2 z-[9999] -translate-y-1/2 h-auto rounded-l-md rounded-r-none px-1.5 py-3 shadow-lg"
      >
        <span className="flex items-center gap-1 text-xs font-medium [writing-mode:vertical-lr] [text-orientation:mixed]">
          <MessageSquareText className="size-3.5 rotate-90" />
          Feedback
        </span>
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share Your Feedback</DialogTitle>
            <DialogDescription>
              Your feedback is sent directly to the project maintainers and helps
              us improve the platform. Thank you for taking the time to share
              your thoughts.
            </DialogDescription>
          </DialogHeader>

          {state === 'success' ? (
            <div className="flex flex-col items-center gap-2 py-6">
              <CheckCircle2 className="size-10 text-green-500" />
              <p className="text-sm text-muted-foreground">
                Thank you! Your feedback has been sent.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <label htmlFor="platform-feedback-text" className="sr-only">
                  Feedback
                </label>
                <Textarea
                  id="platform-feedback-text"
                  ref={textareaRef}
                  placeholder="Tell us about a bug, suggest an improvement, or share what you like..."
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value)
                    if (state === 'error') {
                      setState('idle')
                      setErrorMessage('')
                    }
                  }}
                  rows={5}
                  className="resize-none"
                />
                {errorMessage && (
                  <p className="text-sm text-destructive">{errorMessage}</p>
                )}
              </div>

              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                >
                  {state === 'submitting' ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Submit'
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
