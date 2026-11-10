-- Calendar phase 5: 24-hour reminder emails.
ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT;

-- The hourly job scans only bookings that are still waiting for a reminder.
CREATE INDEX idx_bookings_reminder_due ON bookings (start_utc)
WHERE status = 'confirmed' AND reminder_sent_at IS NULL AND anonymized_at IS NULL;
