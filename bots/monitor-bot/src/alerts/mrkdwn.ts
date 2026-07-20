// Slack interprets &, < and > as control sequences (<!channel>, <@id> mentions) — escape every
// API-sourced string so alert content can never inject a mention or link.
export function escapeSlack(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * mrkdwn link when a URL is known, the escaped label alone otherwise — so a chain without a
 * configured explorer degrades to plain text instead of a broken link.
 */
export function slackLink(url: string | null, label: string) {
  return url ? `<${url}|${escapeSlack(label)}>` : escapeSlack(label)
}
