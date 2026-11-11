# Catering request conversations

Staff reply to catering requests from the portal, and the customer reads and answers on a
private page. The whole conversation stays in the portal: nothing is exchanged through
personal email or phone, and the customer's email only ever says "you have a message" with a link.

## How it works

1. A customer submits the Catering & Events form (unchanged).
2. A Lead or Management opens **Catering Requests** in the portal, clicks **Conversation** on
   the request, writes a reply, and clicks **Send reply**.
3. The customer gets a short email: "Our team sent you a message about your corporate request."
   It contains a private link and **not** the message. The message is only on that page.
4. The customer opens the link (`/inquiry/<long random text>`), reads the team's messages, and
   replies there. No login is needed; the private link is the key.
5. The staff member who first replied gets a portal notification for each customer reply (if
   they are no longer active, every manager is notified instead). The dashboard alert and a red
   badge on the request show how many replies are unread.

Replying moves a **new** request to **reviewed**. A customer reply to a **closed** request
reopens it as **reviewed**.

## Internal notes

Tick **Internal note** to save a note for the team. Notes are clearly marked, never emailed, and
never shown to the customer. They are for things like "asked about a discount on the phone".

## What the customer can and can't see

They see their own request details, the team's messages (by first name only, e.g. "Ana"), and
their own replies. They never see internal notes, staff surnames or accounts, other customers,
or anything about the system. A wrong or made-up link gets the same plain answer as any other.

## If an email doesn't arrive

Each conversation shows the customer's private link with a **Copy customer link** button. Send
it by text, or read it out on the phone. Each staff message also shows "customer emailed" once
the email went out, or "email pending" while it is waiting or retrying.

## Protections

- The private link is 43 random characters and unguessable. Anyone who guesses wrongly is slowed
  down (a limit per visitor) and learns nothing.
- Replies are limited to 20 per request per day and 4,000 characters each. They are plain text only.
- If Turnstile is set up (see `docs/calendar-go-live.md`, Step 7), the customer's reply form uses
  it too; the hidden trap field is always on.
- The customer's page has no analytics, is not cached, is hidden from search engines, and sends
  no referrer.

## Things to know

- Customers reply on the page, not by email. If they reply to the notification email anyway, that
  reply goes to `schedule@shibamatlanta.com`, not into the portal. The email asks them to use the
  page, but check that inbox occasionally.
- The private link is stored (in `catering_requests.thread_token`) so follow-up emails can include
  it and staff can copy it. It is only sent to Lead+ staff, never in the request list.
- Catering requests and their messages are kept; there is no automatic deletion. To remove one,
  ask the developer, or extend the 12-month cleanup used for meeting bookings.
- No attachments in this version; use the quote in the message text.

## Going live

The database change is migration `0017_catering_conversations.sql`. The automatic deploy applies
it and redeploys the email Worker whenever those folders change, then checks the live pages. After
a deploy: submit a test request on the public form, reply from the portal, open the emailed link
in a private window, reply there, and check the unread badge appears in the portal.
