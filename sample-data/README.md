# Sample data

| File | What it is |
|---|---|
| `telemetry-batch.csv` | 40 clean records, flat columns. Unrecognised columns (`altitudeM`, `speedMps`) are nested under `telemetryData` at parse time. |
| `telemetry-batch.ndjson` | The same 40 records as newline-delimited JSON, with `telemetryData` already nested. |
| `telemetry-corrupt.csv` | 13 records exercising every failure mode, described below. |

## What each row of `telemetry-corrupt.csv` proves

| Row | Content | Expected outcome |
|---|---|---|
| 1 | Well-formed record | Stored |
| 2 | Empty `droneId` | Quarantined: `droneId must not be empty` |
| 3 | `not-a-real-timestamp` | Quarantined: unparseable timestamp |
| 4 | `batteryPct` of 4000 | Quarantined: out of range |
| 5 | `lat` of 999 | Quarantined: out of range |
| 6 | Only 3 of 9 columns | Quarantined: `malformed CSV row`, caught at parse time rather than silently misaligning |
| 7 | `PARACHUTE_DEPLOYED` | **Stored** as `UNKNOWN`, with the original value kept in `raw`. An unrecognised event type is not a reason to lose data. |
| 8 | Every optional field empty | **Stored.** Empty cells are absent values, not zeros. |
| 9 | Timestamp as epoch seconds | **Stored**, correctly resolved to 2026 rather than 1970 |
| 10 | Timestamp in 2099 | Quarantined: clock fault. Storing it would corrupt every time-window query. |
| 11 | `MOTOR_FAULT` with status 500 | **Stored** with `severity = 'error'` |
| 12 | Byte-identical duplicate of row 1 | **Deduplicated.** Same derived `event_id`, so `ON CONFLICT DO NOTHING` skips it. |
| 13 | Well-formed record | Stored |

Expected totals: **6 stored** (rows 1, 7, 8, 9, 11, 13), **6 quarantined** (rows 2, 3, 4, 5, 6, 10), **1 in-batch duplicate** (row 12).

These numbers are asserted in `tests/unit/sample-data.test.ts`, so the table above cannot drift away from what the pipeline actually does.
