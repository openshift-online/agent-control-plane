import { getSession } from "@/lib/session"
import { env } from "@/lib/env"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function resolveUsername(accessToken: string): string {
  try {
    const parts = accessToken.split(".")
    if (parts.length === 3) {
      const payload: Record<string, unknown> = JSON.parse(
        Buffer.from(parts[1], "base64url").toString()
      )
      if (typeof payload.preferred_username === "string") {
        return payload.preferred_username
      }
    }
  } catch {
    // malformed token
  }
  return "unknown"
}

function buildSlackBlocks(text: string, username: string, pagePath: string) {
  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Platform Feedback", emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*From:* ${username} · *Page:* ${pagePath} · *Time:* <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
          },
        ],
      },
    ],
  }
}

export async function GET() {
  const available = Boolean(env.FEEDBACK_SLACK_WEBHOOK_URL)
  return Response.json({ available })
}

export async function POST(request: Request) {
  const webhookUrl = env.FEEDBACK_SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    return Response.json(
      { error: "Feedback is not configured" },
      { status: 503 }
    )
  }

  const session = await getSession()
  if (!session.accessToken) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const username = resolveUsername(session.accessToken)

  let body: Record<string, unknown>
  try {
    body = await request.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 })
  }

  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text) {
    return Response.json(
      { error: "Feedback text is required" },
      { status: 400 }
    )
  }

  const pagePath = typeof body.pagePath === "string" ? body.pagePath : "/"

  const slackPayload = buildSlackBlocks(text, username, pagePath)

  try {
    const slackRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload),
    })

    if (!slackRes.ok) {
      console.error("[/api/feedback] Slack webhook failed:", slackRes.status)
      return Response.json(
        { error: "Failed to deliver feedback" },
        { status: 502 }
      )
    }

    return Response.json({ success: true })
  } catch (err) {
    console.error("[/api/feedback] Slack webhook error:", err instanceof Error ? err.message : err)
    return Response.json(
      { error: "Failed to deliver feedback" },
      { status: 502 }
    )
  }
}
