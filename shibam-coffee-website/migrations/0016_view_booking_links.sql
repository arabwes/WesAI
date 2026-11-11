-- Lets the person who owns a booking link (and Management) see and copy it again.
-- Until now only a hash of each link was kept, so a link could be seen once, at
-- creation. The token is stored so the Booking Links page can show it. It is
-- returned only to the link's owner and Management, and it is erased when the
-- link is revoked. Links created before this migration have no stored token and
-- cannot be shown again (create a new link instead). Invitees' own manage links
-- are unaffected: those stay hash-only.
ALTER TABLE booking_links ADD COLUMN token TEXT;

-- "Book up to" is now limited to 1-30 days. Bring any existing meeting type that
-- was set higher (the old choices went up to 90 days) back into range.
UPDATE event_types SET max_days_ahead = 30 WHERE max_days_ahead > 30;
