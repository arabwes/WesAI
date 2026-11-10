-- Calendar phase 2: optional "don't book me over my published work shifts".
ALTER TABLE booking_settings ADD COLUMN avoid_shifts INTEGER NOT NULL DEFAULT 0 CHECK (avoid_shifts IN (0, 1));
