# Weekly inventory cleanup (Oct 2026)

Fixes for the data-entry problems found in the 9 counts from 9/23–10/21.
The schema and history cleanup ship in
`migrations/0011_inventory_count_integrity.sql`; units and walk-order
sections need owner input and ship in a second, generated migration.

## Step 1 — migration 0011 (automatic)

Applied with `npm run db:migrate:production`. Tested against a full copy of
production before applying.

| Change | Effect |
| --- | --- |
| `form_entries.catalog_id` | Every past row is linked to its item's permanent ID. 12 rows-of-history recorded under old names are merged back (see table below). |
| `inventory_sections` + `catalog.section_id / sort_order` | Walk-order sections. Seeded with the current groups as placeholders until step 2. |
| `catalog.max_qty` | Optional per-item maximum for the outlier check. |
| `inventory_counts` | One row per count: shared draft → submitted once, or void. Database rules allow one open draft and one submitted count per date. |
| `form_entry_edits` | Old value, new value, who, when, and why for every edit. |

Renamed items merged onto their original IDs (owner approved all 12):

| Old name in history | Current name | Catalog ID |
| --- | --- | --- |
| Matcha | Matcha (17.6lb bag) | catalog_seed_0006 |
| 1883 Blackberry | Blackberry Syrup | catalog_seed_0022 |
| 1883 Blueberry | Blueberry Syrup | catalog_seed_0023 |
| Brown Sugar Sauce | Brown Sugar Syrup | catalog_seed_0024 |
| Hazelnut | Hazelnut Syrup | catalog_seed_0033 |
| 16oz Non-Branded Hot Cup | 6oz Non-Branded Paper Cup | catalog_seed_0059 |
| 16oz Non-Branded Paper Cup | 16oz Non-Branded Plastic Cup | catalog_seed_0060 |
| 16oz & 20oz Poly Cup | 16oz Poly Cup | catalog_seed_0062 |
| 12–20oz Paper Cup Hot Lids | Hot Lids | catalog_seed_0064 |
| Almudhesh Evaporated Milk | Evaporated Milk | catalog_seed_0106 |
| 50g Dragon Fruit Diced | Freeze Dried Dragon Fruit | catalog_seed_0116 |
| Hoodies | Shirt | catalog_seed_0124 |

History cleanup (records are voided, never deleted — exports skip them):

- **10/13 `f9d31be0`** — all 99 items at 0, submitted 7 seconds before the
  real count (`6fa3ff3c`). Voided.
- **10/21 split** — `e595d598` (13:27, mis-dated 10/15) and `dd769915`
  (13:56) were one count. The 8 items only the first half counted (the
  Yemeni coffees and teas) were copied onto `dd769915` and logged as edits;
  the 8 items both halves counted were identical except Matcha, where the
  later value was kept. `e595d598` was re-dated 10/21 and voided.

Not changed: the outlier values already in history (Pistachio Sauce 116 on
10/13, Vanilla Syrup 73 on 10/15). Correct them, if you want, through Admin
→ Submissions — the edit is logged with a reason.

## Step 2 — count units and walk-order sections (needs you)

1. Open `inventory-units-worksheet.csv` (one row per active item, with its
   recent totals; 27 rows are flagged because values swing more than 3×).
2. Fill in, per row:
   - **count_unit** — the purchase unit, e.g. `cases of 6 cans`,
     `950 g bottles`, `25 lb bags`. Blank keeps the current unit.
   - **max_qty** — the most you'd ever stock (optional; `suggested_max` is
     3× the usual count, but ignore it on flagged rows — those histories mix
     units).
   - **section** — where the item physically sits, e.g. `Back storage`,
     `Under-bar fridge`, `Front cabinet`, `Dine-in glassware`.
   - **walk_order** — the order you'd reach it on a walk-through (1, 2, 3…
     across the whole store). Sections are ordered by their first item.
3. Generate and review the migration:
   ```
   node scripts/build-inventory-units-migration.mjs
   ```
   This writes `migrations/0012_inventory_units_and_sections.sql` and stops
   with a list of problems if any cell is invalid.
4. Apply it with `npm run db:migrate:production`. Placeholder sections left
   with no items are marked inactive automatically.

Units and sections can also be edited one item at a time in Admin →
Catalog (Weekly Inventory Count), which now has Section, Order, and Max qty
columns and a section manager.
