-- Scheduling automation and Toast sales context for the coverage heatmap.

-- Normalize the former 23:59 all-day sentinel to the selectable midnight
-- boundary. In availability windows, an end value of 00:00 means end of day.
UPDATE availability_rules SET end_time = '00:00' WHERE end_time = '23:59';
UPDATE availability_exceptions SET end_time = '00:00' WHERE end_time = '23:59';
UPDATE availability_exception_series SET end_time = '00:00' WHERE end_time = '23:59';

CREATE TABLE toast_hourly_sales (
  business_date TEXT NOT NULL,
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  net_sales_cents INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (business_date, hour)
);

CREATE INDEX idx_toast_hourly_sales_date
ON toast_hourly_sales (business_date, hour);

CREATE TABLE toast_sales_sync_state (
  location_id TEXT PRIMARY KEY,
  period_start TEXT,
  period_end TEXT,
  completed_weeks INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'syncing', 'ready', 'error')),
  last_synced_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
