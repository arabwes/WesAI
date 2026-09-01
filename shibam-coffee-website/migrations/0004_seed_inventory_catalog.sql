-- Restore the canonical inventory, dessert, and local-order catalogs.
-- Existing items are preserved; matching form-type/name pairs are not duplicated.

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0001', 'inventory', 'Coffee Beans', 'Dark Roast', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.001Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Dark Roast' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0002', 'inventory', 'Coffee Beans', 'Medium Roast', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.002Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Medium Roast' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0003', 'inventory', 'Coffee Beans', 'Light Roast', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.003Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Light Roast' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0004', 'inventory', 'Coffee Beans', 'Decaf Beans', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.004Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Decaf Beans' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0005', 'inventory', 'Green', 'Green Coffee Beans', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.005Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Green Coffee Beans' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0006', 'inventory', 'Green', 'Matcha', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.006Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Matcha' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0007', 'inventory', 'Coffee / Tea Mix', 'Professional Roasting', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.007Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Professional Roasting' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0008', 'inventory', 'Coffee / Tea Mix', 'Adani Tea', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.008Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Adani Tea' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0009', 'inventory', 'Coffee / Tea Mix', 'Yemeni Tea', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.009Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Yemeni Tea' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0010', 'inventory', 'Coffee / Tea Mix', 'Drip Coffee Grind', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.010Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Drip Coffee Grind' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0011', 'inventory', 'Coffee / Tea Mix', 'Turkish', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.011Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Turkish' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0012', 'inventory', 'Coffee / Tea Mix', 'Saudi', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.012Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Saudi' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0013', 'inventory', 'Coffee / Tea Mix', 'Jubani', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.013Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Jubani' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0014', 'inventory', 'Coffee / Tea Mix', 'Moroccan Mint Tea', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.014Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Moroccan Mint Tea' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0015', 'inventory', 'Coffee / Tea Mix', 'Meditative Mind', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.015Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Meditative Mind' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0016', 'inventory', 'Coffee / Tea Mix', 'Ginger Tea', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.016Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Ginger Tea' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0017', 'inventory', 'Coffee / Tea Mix', 'Saffron', 'box', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.017Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Saffron' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0018', 'inventory', 'Coffee / Tea Mix', 'Sana''ani', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.018Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Sana''ani' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0019', 'inventory', 'Coffee / Tea Mix', 'Rad''ai', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.019Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Rad''ai' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0020', 'inventory', 'Coffee / Tea Mix', 'Qishr / Coffee Husks', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.020Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Qishr / Coffee Husks' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0021', 'inventory', 'Coffee / Tea Mix', 'Qishr Spices', 'lb', '', 'Kitchen', '', 'active', 'system-seed', '2026-09-01T00:00:00.021Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Qishr Spices' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0022', 'inventory', 'Sauce / Syrup', '1883 Blackberry', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.022Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '1883 Blackberry' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0023', 'inventory', 'Sauce / Syrup', '1883 Blueberry', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.023Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '1883 Blueberry' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0024', 'inventory', 'Sauce / Syrup', 'Brown Sugar Sauce', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.024Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Brown Sugar Sauce' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0025', 'inventory', 'Sauce / Syrup', 'Caramel Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.025Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Caramel Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0026', 'inventory', 'Sauce / Syrup', 'Caramel Sauce', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.026Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Caramel Sauce' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0027', 'inventory', 'Sauce / Syrup', 'Chocolate Powder', 'Bag', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.027Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Chocolate Powder' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0028', 'inventory', 'Sauce / Syrup', 'Chocolate Sauce', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.028Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Chocolate Sauce' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0029', 'inventory', 'Sauce / Syrup', 'Dragon Fruit Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.029Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Dragon Fruit Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0030', 'inventory', 'Sauce / Syrup', 'Frappe Mix Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.030Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Frappe Mix Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0031', 'inventory', 'Sauce / Syrup', 'Freeze Dried Strawberry', 'Bag', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.031Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Freeze Dried Strawberry' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0032', 'inventory', 'Sauce / Syrup', 'French Vanilla Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.032Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'French Vanilla Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0033', 'inventory', 'Sauce / Syrup', 'Hazelnut', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.033Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Hazelnut' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0034', 'inventory', 'Sauce / Syrup', 'Honey Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.034Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Honey Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0035', 'inventory', 'Sauce / Syrup', 'Lotus Spread', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.035Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Lotus Spread' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0036', 'inventory', 'Sauce / Syrup', 'Mango Pulp', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.036Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Mango Pulp' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0037', 'inventory', 'Sauce / Syrup', 'Mango Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.037Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Mango Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0038', 'inventory', 'Sauce / Syrup', 'Peach Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.038Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Peach Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0039', 'inventory', 'Sauce / Syrup', 'Pistachio Sauce', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.039Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Pistachio Sauce' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0040', 'inventory', 'Sauce / Syrup', 'Pumpkin Spice Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.040Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Pumpkin Spice Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0041', 'inventory', 'Sauce / Syrup', 'Pumpkin Pie Sauce', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.041Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Pumpkin Pie Sauce' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0042', 'inventory', 'Sauce / Syrup', 'Raspberry Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.042Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Raspberry Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0043', 'inventory', 'Sauce / Syrup', 'Rose Syrup', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.043Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Rose Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0044', 'inventory', 'Sauce / Syrup', 'SF Caramel Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.044Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'SF Caramel Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0045', 'inventory', 'Sauce / Syrup', 'SF Vanilla Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.045Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'SF Vanilla Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0046', 'inventory', 'Sauce / Syrup', 'Strawberry Pieces', 'Bag', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.046Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Strawberry Pieces' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0047', 'inventory', 'Sauce / Syrup', 'Strawberry Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.047Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Strawberry Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0048', 'inventory', 'Sauce / Syrup', 'Toot Shami', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.048Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Toot Shami' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0049', 'inventory', 'Sauce / Syrup', 'Vanilla Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.049Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Vanilla Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0050', 'inventory', 'Sauce / Syrup', 'Vimto', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.050Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Vimto' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0051', 'inventory', 'Sauce / Syrup', 'White Chocolate Sauce', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.051Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'White Chocolate Sauce' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0052', 'inventory', 'Sauce / Syrup', 'White Chocolate Syrup', 'Bottle', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.052Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'White Chocolate Syrup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0053', 'inventory', 'Sauce / Syrup', 'White Chocolate Powder', 'Bag', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.053Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'White Chocolate Powder' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0054', 'inventory', 'Warehouse — Cups & Lids', '4oz Paper Cup', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.054Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '4oz Paper Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0055', 'inventory', 'Warehouse — Cups & Lids', '6oz Paper Cup', 'Box 1000', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.055Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '6oz Paper Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0056', 'inventory', 'Warehouse — Cups & Lids', '8oz Paper Cup', 'Box 500', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.056Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '8oz Paper Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0057', 'inventory', 'Warehouse — Cups & Lids', '12oz Paper Cup (Double Insulation)', 'Box 500', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.057Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '12oz Paper Cup (Double Insulation)' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0058', 'inventory', 'Warehouse — Cups & Lids', '16oz Paper Cup (Double Insulation)', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.058Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '16oz Paper Cup (Double Insulation)' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0059', 'inventory', 'Warehouse — Cups & Lids', '16oz Non-Branded Hot Cup', 'Box 1000', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.059Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '16oz Non-Branded Hot Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0060', 'inventory', 'Warehouse — Cups & Lids', '16oz Non-Branded Paper Cup', 'Box 1000', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.060Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '16oz Non-Branded Paper Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0061', 'inventory', 'Warehouse — Cups & Lids', '20oz Paper Cup', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.061Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '20oz Paper Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0062', 'inventory', 'Warehouse — Cups & Lids', '16oz & 20oz Poly Cup', 'Box 1000', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.062Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '16oz & 20oz Poly Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0063', 'inventory', 'Warehouse — Cups & Lids', '2oz Poly Box', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.063Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '2oz Poly Box' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0064', 'inventory', 'Warehouse — Cups & Lids', '12–20oz Paper Cup Hot Lids', 'Box 1000', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.064Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '12–20oz Paper Cup Hot Lids' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0065', 'inventory', 'Warehouse — Cups & Lids', 'Clear Cup Lids', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.065Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Clear Cup Lids' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0066', 'inventory', 'Warehouse — Cups & Lids', 'Clear Sippy Lids', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.066Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Clear Sippy Lids' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0067', 'inventory', 'Warehouse — Cups & Lids', 'Dome Clear Lids', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.067Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Dome Clear Lids' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0068', 'inventory', 'Warehouse — Cups & Lids', 'Sleeve', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.068Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Sleeve' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0069', 'inventory', 'Warehouse — Cups & Lids', '2 Cups Holder', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.069Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '2 Cups Holder' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0070', 'inventory', 'Warehouse — Cups & Lids', '4 Cups Holder', 'Box 200', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.070Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '4 Cups Holder' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0071', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '4.5oz Ceramic Mug', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.071Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '4.5oz Ceramic Mug' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0072', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '6oz Tea Glass Cup', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.072Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '6oz Tea Glass Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0073', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '12oz Ceramic Mugs (Latte)', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.073Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '12oz Ceramic Mugs (Latte)' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0074', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '14oz Ceramic Cup (Dine-in)', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.074Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '14oz Ceramic Cup (Dine-in)' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0075', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '16oz Glass Mug (Iced Latte)', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.075Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '16oz Glass Mug (Iced Latte)' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0076', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '16oz Glass Coke Cup', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.076Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '16oz Glass Coke Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0077', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '20oz Glass Mug', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.077Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '20oz Glass Mug' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0078', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '20oz Glass Coke Cup', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.078Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '20oz Glass Coke Cup' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0079', 'inventory', 'Warehouse — Glass, Ceramic & Metal', 'Small Glass Pot Base', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.079Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Small Glass Pot Base' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0080', 'inventory', 'Warehouse — Glass, Ceramic & Metal', 'Medium Glass Pot', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.080Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Medium Glass Pot' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0081', 'inventory', 'Warehouse — Glass, Ceramic & Metal', 'Large Glass Pot', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.081Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Large Glass Pot' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0082', 'inventory', 'Warehouse — Glass, Ceramic & Metal', 'Glass Coffee/Tea Base', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.082Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Glass Coffee/Tea Base' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0083', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '35oz Metal Coffee Pot', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.083Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '35oz Metal Coffee Pot' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0084', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '5 Liter Tea/Coffee Metal Pot', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.084Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '5 Liter Tea/Coffee Metal Pot' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0085', 'inventory', 'Warehouse — Glass, Ceramic & Metal', '2 Tbsp Metal Spoon', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.085Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '2 Tbsp Metal Spoon' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0086', 'inventory', 'Warehouse — Glass, Ceramic & Metal', 'Small Wood Plate', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.086Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Small Wood Plate' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0087', 'inventory', 'Warehouse — Glass, Ceramic & Metal', 'Large Wood Plate', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.087Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Large Wood Plate' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0088', 'inventory', 'Warehouse — Packaging & Paper', '1 lb Bags', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.088Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '1 lb Bags' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0089', 'inventory', 'Warehouse — Packaging & Paper', '15 lb Bag', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.089Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '15 lb Bag' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0090', 'inventory', 'Warehouse — Packaging & Paper', '1oz Tin Box', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.090Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '1oz Tin Box' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0091', 'inventory', 'Warehouse — Packaging & Paper', '16oz Tin Box', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.091Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '16oz Tin Box' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0092', 'inventory', 'Warehouse — Packaging & Paper', '6" Clear Box', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.092Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '6" Clear Box' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0093', 'inventory', 'Warehouse — Packaging & Paper', '96oz Travel Box', 'Box 50', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.093Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '96oz Travel Box' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0094', 'inventory', 'Warehouse — Packaging & Paper', 'Honeycomb Plastic To-Go Box', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.094Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Honeycomb Plastic To-Go Box' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0095', 'inventory', 'Warehouse — Packaging & Paper', 'Sandwich To-Go Box', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.095Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Sandwich To-Go Box' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0096', 'inventory', 'Warehouse — Packaging & Paper', 'Small Shopping Bags', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.096Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Small Shopping Bags' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0097', 'inventory', 'Warehouse — Packaging & Paper', 'Large Shopping Bags', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.097Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Large Shopping Bags' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0098', 'inventory', 'Warehouse — Packaging & Paper', 'Shopping Bags 4.5x10.25', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.098Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Shopping Bags 4.5x10.25' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0099', 'inventory', 'Warehouse — Packaging & Paper', 'Napkin', 'Box 5500', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.099Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Napkin' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0100', 'inventory', 'Warehouse — Packaging & Paper', 'Jumbo Straws', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.100Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Jumbo Straws' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0101', 'inventory', 'Warehouse — Packaging & Paper', 'Forks', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.101Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Forks' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0102', 'inventory', 'Warehouse — Packaging & Paper', 'Knife', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.102Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Knife' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0103', 'inventory', 'Warehouse — Packaging & Paper', 'Thermal Paper', 'Roll', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.103Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Thermal Paper' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0104', 'inventory', 'Warehouse — Packaging & Paper', 'Shibam Sticker Roll', 'Roll 3333', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.104Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Shibam Sticker Roll' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0105', 'inventory', 'Warehouse — Packaging & Paper', 'Custom Acrylic Percolator Cover (5 gal)', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.105Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Custom Acrylic Percolator Cover (5 gal)' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0106', 'inventory', 'Warehouse — Pantry & Spices', 'Almudhesh Evaporated Milk', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.106Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Almudhesh Evaporated Milk' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0107', 'inventory', 'Warehouse — Pantry & Spices', '50 lb Sugar', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.107Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '50 lb Sugar' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0108', 'inventory', 'Warehouse — Pantry & Spices', 'Raw Brown Sugar Stick Packets', 'Branded Box 2000', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.108Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Raw Brown Sugar Stick Packets' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0109', 'inventory', 'Warehouse — Pantry & Spices', 'Blue Sugar Substitute Stick Packets', 'Branded Box 2000', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.109Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Blue Sugar Substitute Stick Packets' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0110', 'inventory', 'Warehouse — Pantry & Spices', 'Pink Sugar Substitute Stick Packets', 'Branded Box 2000', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.110Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Pink Sugar Substitute Stick Packets' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0111', 'inventory', 'Warehouse — Pantry & Spices', 'Shibam Spices', 'lb', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.111Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Shibam Spices' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0112', 'inventory', 'Warehouse — Pantry & Spices', 'Cardamom', 'lb', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.112Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Cardamom' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0113', 'inventory', 'Warehouse — Pantry & Spices', 'Cinnamon', 'lb', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.113Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Cinnamon' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0114', 'inventory', 'Warehouse — Pantry & Spices', 'Cloves', 'lb', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.114Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Cloves' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0115', 'inventory', 'Warehouse — Pantry & Spices', 'Ginger Spice', 'lb', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.115Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Ginger Spice' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0116', 'inventory', 'Warehouse — Pantry & Spices', '50g Dragon Fruit Diced', 'Bag', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.116Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = '50g Dragon Fruit Diced' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0117', 'inventory', 'Warehouse — Pantry & Spices', 'Lotus Spread Bucket 17.6 lb', 'Bucket', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.117Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Lotus Spread Bucket 17.6 lb' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0118', 'inventory', 'Warehouse — Pantry & Spices', 'Sprite Can', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.118Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Sprite Can' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0119', 'inventory', 'Warehouse — K-Cups & Merch', 'Dark K-Cup 12PC', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.119Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Dark K-Cup 12PC' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0120', 'inventory', 'Warehouse — K-Cups & Merch', 'Dark K-Cup 24PC', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.120Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Dark K-Cup 24PC' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0121', 'inventory', 'Warehouse — K-Cups & Merch', 'Medium K-Cup 12PC', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.121Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Medium K-Cup 12PC' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0122', 'inventory', 'Warehouse — K-Cups & Merch', 'Medium K-Cup 24PC', 'Box', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.122Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Medium K-Cup 24PC' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0123', 'inventory', 'Warehouse — K-Cups & Merch', 'Apron', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.123Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Apron' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0124', 'inventory', 'Warehouse — K-Cups & Merch', 'Hoodies', 'Piece', '', 'Storage', '', 'active', 'system-seed', '2026-09-01T00:00:00.124Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'inventory' AND name = 'Hoodies' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0125', 'dessert', '', 'Honeycomb', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.125Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Honeycomb' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0126', 'dessert', '', 'Sabaya', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.126Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Sabaya' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0127', 'dessert', '', 'Pistachio Milk Cake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.127Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Pistachio Milk Cake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0128', 'dessert', '', 'Lotus Milk Cake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.128Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Lotus Milk Cake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0129', 'dessert', '', 'Ras Malai Milk Cake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.129Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Ras Malai Milk Cake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0130', 'dessert', '', 'Rose Milk Cake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.130Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Rose Milk Cake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0131', 'dessert', '', 'Oreo Milk Cake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.131Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Oreo Milk Cake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0132', 'dessert', '', 'Caramel Milk Cake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.132Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Caramel Milk Cake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0133', 'dessert', '', 'Mango Milk Cake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.133Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Mango Milk Cake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0134', 'dessert', '', 'Kunafa Cheesecake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.134Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Kunafa Cheesecake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0135', 'dessert', '', 'Lotus Cheesecake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.135Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Lotus Cheesecake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0136', 'dessert', '', 'Pistachio Cheesecake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.136Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Pistachio Cheesecake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0137', 'dessert', '', 'Berry Cheesecake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.137Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Berry Cheesecake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0138', 'dessert', '', 'Tiramisu Cheesecake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.138Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Tiramisu Cheesecake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0139', 'dessert', '', 'Tiramisu', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.139Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Tiramisu' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0140', 'dessert', '', 'Dubai Chocolate', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.140Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Dubai Chocolate' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0141', 'dessert', '', 'Dubai Brownie', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.141Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Dubai Brownie' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0142', 'dessert', '', 'Dark Chocolate', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.142Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Dark Chocolate' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0143', 'dessert', '', 'Matcha Chocolate', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.143Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Matcha Chocolate' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0144', 'dessert', '', 'Caramel Chocolate', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.144Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Caramel Chocolate' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0145', 'dessert', '', 'Sticky Toffee Date Cake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.145Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Sticky Toffee Date Cake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0146', 'dessert', '', 'Persian Love Cake', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.146Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Persian Love Cake' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0147', 'dessert', '', 'Pistachio Tart', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.147Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Pistachio Tart' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0148', 'dessert', '', 'Mango Tart', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.148Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Mango Tart' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0149', 'dessert', '', 'Strawberry Frasier', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.149Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Strawberry Frasier' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0150', 'dessert', '', 'Cake Pops', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.150Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Cake Pops' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0151', 'dessert', '', 'Simit — Sesame', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.151Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Simit — Sesame' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0152', 'dessert', '', 'Simit — Zaatar', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.152Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Simit — Zaatar' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0153', 'dessert', '', 'Zaatar Focaccia', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.153Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Zaatar Focaccia' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0154', 'dessert', '', 'Olive Focaccia', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.154Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Olive Focaccia' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0155', 'dessert', '', 'Rosemary Focaccia', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.155Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Rosemary Focaccia' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0156', 'dessert', '', 'Croissants', '', '', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.156Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'dessert' AND name = 'Croissants' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0157', 'local-order', 'Bar & Front of House', 'Whole Milk', 'Jug/Bottle', '6', '', '20', 'active', 'system-seed', '2026-09-01T00:00:00.157Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Whole Milk' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0158', 'local-order', 'Bar & Front of House', '2% Milk', 'Jug/Bottle', '1', '', '2', 'active', 'system-seed', '2026-09-01T00:00:00.158Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = '2% Milk' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0159', 'local-order', 'Bar & Front of House', 'Half & Half', 'Jug/Bottle', '2', '', '4', 'active', 'system-seed', '2026-09-01T00:00:00.159Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Half & Half' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0160', 'local-order', 'Bar & Front of House', 'Heavy Cream', 'Jug/Bottle', '3', '', '4', 'active', 'system-seed', '2026-09-01T00:00:00.160Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Heavy Cream' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0161', 'local-order', 'Bar & Front of House', 'Whipped Cream', 'Jug/Bottle', '1', '', '3', 'active', 'system-seed', '2026-09-01T00:00:00.161Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Whipped Cream' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0162', 'local-order', 'Bar & Front of House', 'Lime', 'Bag', '0.1', '', '1', 'active', 'system-seed', '2026-09-01T00:00:00.162Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Lime' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0163', 'local-order', 'Bar & Front of House', 'Mint', 'Bunch', '0.1', '', '1', 'active', 'system-seed', '2026-09-01T00:00:00.163Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Mint' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0164', 'local-order', 'Bar & Front of House', 'Honey', 'Jug/Bottle', '2', '', '5', 'active', 'system-seed', '2026-09-01T00:00:00.164Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Honey' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0165', 'local-order', 'Bar & Front of House', 'Lemonade', 'Jug/Bottle', '2', '', '6', 'active', 'system-seed', '2026-09-01T00:00:00.165Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Lemonade' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0166', 'local-order', 'Bar & Front of House', 'Mascarpone', 'Tub', '2', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.166Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Mascarpone' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0167', 'local-order', 'Bar & Front of House', 'Water (Kirkland)', 'Case', '0.5', '', '1', 'active', 'system-seed', '2026-09-01T00:00:00.167Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Water (Kirkland)' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0168', 'local-order', 'Bar & Front of House', 'Water (Fiji)', 'Case', '0.5', '', '1', 'active', 'system-seed', '2026-09-01T00:00:00.168Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Water (Fiji)' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0169', 'local-order', 'Bar & Front of House', 'Sprite', 'Case', '0.5', '', '3', 'active', 'system-seed', '2026-09-01T00:00:00.169Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Sprite' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0170', 'local-order', 'Bar & Front of House', 'Parchment Paper (register)', 'Box', '1', '', '2', 'active', 'system-seed', '2026-09-01T00:00:00.170Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Parchment Paper (register)' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0171', 'local-order', 'Cleaning & Supplies', 'Large Trash Bags 50+ Gallon', 'Roll', '2', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.171Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Large Trash Bags 50+ Gallon' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0172', 'local-order', 'Cleaning & Supplies', 'Bathroom Trash Bags 13 Gallon', 'Roll', '2', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.172Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Bathroom Trash Bags 13 Gallon' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0173', 'local-order', 'Cleaning & Supplies', 'Paper Towels', 'Roll', '2', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.173Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Paper Towels' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0174', 'local-order', 'Cleaning & Supplies', 'Pine Sol', 'Jug/Bottle', '2', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.174Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Pine Sol' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0175', 'local-order', 'Cleaning & Supplies', 'Hand Towels', 'Pack', '1', '', '', 'active', 'system-seed', '2026-09-01T00:00:00.175Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Hand Towels' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0176', 'local-order', 'Check Downstairs Storage First', 'Evaporated Milk', 'Case', '1', '', '4', 'active', 'system-seed', '2026-09-01T00:00:00.176Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Evaporated Milk' COLLATE NOCASE);

INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
SELECT 'catalog_seed_0177', 'local-order', 'Check Downstairs Storage First', 'Condensed Milk', 'Case', '1', '', '4', 'active', 'system-seed', '2026-09-01T00:00:00.177Z'
WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = 'local-order' AND name = 'Condensed Milk' COLLATE NOCASE);
