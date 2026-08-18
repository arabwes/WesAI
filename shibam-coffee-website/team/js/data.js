// /team/js/data.js
// Item lists for the three employee forms, transcribed from the Google Sheets
// they replace. Editing a list here changes the form on the next page load —
// no other file needs to be touched.

const INVENTORY_ITEMS = [
  {
    category: 'Coffee Beans',
    location: 'Kitchen',
    items: [
      { name: 'Dark Roast', unit: 'lb' },
      { name: 'Medium Roast', unit: 'lb' },
      { name: 'Light Roast', unit: 'lb' },
      { name: 'Decaf Beans', unit: 'lb' }
    ]
  },
  {
    category: 'Green',
    location: 'Kitchen',
    items: [
      { name: 'Green Coffee Beans', unit: 'lb' },
      { name: 'Matcha', unit: 'lb' }
    ]
  },
  {
    category: 'Coffee / Tea Mix',
    location: 'Kitchen',
    items: [
      { name: 'Professional Roasting', unit: 'lb' },
      { name: 'Adani Tea', unit: 'lb' },
      { name: 'Yemeni Tea', unit: 'lb' },
      { name: 'Drip Coffee Grind', unit: 'lb' },
      { name: 'Turkish', unit: 'lb' },
      { name: 'Saudi', unit: 'lb' },
      { name: 'Jubani', unit: 'lb' },
      { name: 'Moroccan Mint Tea', unit: 'lb' },
      { name: 'Meditative Mind', unit: 'lb' },
      { name: 'Ginger Tea', unit: 'lb' },
      { name: 'Saffron', unit: 'box' },
      { name: "Sana'ani", unit: 'lb' },
      { name: "Rad'ai", unit: 'lb' },
      { name: 'Qishr / Coffee Husks', unit: 'lb' },
      { name: 'Qishr Spices', unit: 'lb' }
    ]
  },
  {
    category: 'Kitchen — Pastries & Food',
    location: 'Kitchen',
    items: [
      { name: 'Honeycomb 16"', unit: 'Tray' },
      { name: 'Sabaya 16"', unit: 'Tray' },
      { name: 'Large Dubai Chocolate', unit: 'Piece' },
      { name: 'Small Dubai Chocolate', unit: 'Bar' },
      { name: 'Lotus Cheesecake', unit: 'Tray' },
      { name: 'Lotus Milk Cake', unit: 'Tray' },
      { name: 'Saffron Pastry', unit: 'Tray' },
      { name: 'Date Cake', unit: 'Tray' },
      { name: 'Pistachio Basbousa', unit: 'Tray' },
      { name: 'Pistachio Bites', unit: '24 Count' },
      { name: 'Pistachio Cheesecake', unit: 'Tray' },
      { name: 'Pistachio Milk Cake', unit: 'Tray' },
      { name: 'Caramel Milk Cake', unit: 'Tray' }
    ]
  },
  {
    category: 'Sauce / Syrup',
    location: 'Storage',
    items: [
      { name: '1883 Blackberry', unit: 'Bottle' },
      { name: '1883 Blueberry', unit: 'Bottle' },
      { name: 'Brown Sugar Sauce', unit: 'Bottle' },
      { name: 'Caramel Syrup', unit: 'Bottle' },
      { name: 'Caramel Sauce', unit: 'Bottle' },
      { name: 'Chocolate Powder', unit: 'Bag' },
      { name: 'Chocolate Sauce', unit: 'Bottle' },
      { name: 'Dragon Fruit Syrup', unit: 'Bottle' },
      { name: 'Frappe Mix Syrup', unit: 'Bottle' },
      { name: 'Freeze Dried Strawberry', unit: 'Bag' },
      { name: 'French Vanilla Syrup', unit: 'Bottle' },
      { name: 'Hazelnut', unit: 'Bottle' },
      { name: 'Honey Syrup', unit: 'Bottle' },
      { name: 'Lotus Spread', unit: 'Box' },
      { name: 'Mango Pulp', unit: 'Box' },
      { name: 'Mango Syrup', unit: 'Bottle' },
      { name: 'Peach Syrup', unit: 'Bottle' },
      { name: 'Pistachio Sauce', unit: 'Box' },
      { name: 'Pumpkin Spice Syrup', unit: 'Bottle' },
      { name: 'Pumpkin Pie Sauce', unit: 'Bottle' },
      { name: 'Raspberry Syrup', unit: 'Bottle' },
      { name: 'Rose Syrup', unit: 'Box' },
      { name: 'SF Caramel Syrup', unit: 'Bottle' },
      { name: 'SF Vanilla Syrup', unit: 'Bottle' },
      { name: 'Strawberry Pieces', unit: 'Bag' },
      { name: 'Strawberry Syrup', unit: 'Bottle' },
      { name: 'Toot Shami', unit: 'Bottle' },
      { name: 'Vanilla Syrup', unit: 'Bottle' },
      { name: 'Vimto', unit: 'Box' },
      { name: 'White Chocolate Sauce', unit: 'Bottle' },
      { name: 'White Chocolate Syrup', unit: 'Bottle' },
      { name: 'White Chocolate Powder', unit: 'Bag' }
    ]
  },
  {
    category: 'Warehouse — Cups & Lids',
    location: 'Storage',
    items: [
      { name: '4oz Paper Cup', unit: 'Box' },
      { name: '6oz Paper Cup', unit: 'Box 1000' },
      { name: '8oz Paper Cup', unit: 'Box 500' },
      { name: '12oz Paper Cup (Double Insulation)', unit: 'Box 500' },
      { name: '16oz Paper Cup (Double Insulation)', unit: 'Box' },
      { name: '16oz Non-Branded Hot Cup', unit: 'Box 1000' },
      { name: '16oz Non-Branded Paper Cup', unit: 'Box 1000' },
      { name: '20oz Paper Cup', unit: 'Box' },
      { name: '16oz & 20oz Poly Cup', unit: 'Box 1000' },
      { name: '2oz Poly Box', unit: 'Box' },
      { name: '12–20oz Paper Cup Hot Lids', unit: 'Box 1000' },
      { name: 'Clear Cup Lids', unit: 'Box' },
      { name: 'Clear Sippy Lids', unit: 'Box' },
      { name: 'Dome Clear Lids', unit: 'Box' },
      { name: 'Sleeve', unit: 'Box' },
      { name: '2 Cups Holder', unit: 'Box' },
      { name: '4 Cups Holder', unit: 'Box 200' }
    ]
  },
  {
    category: 'Warehouse — Glass, Ceramic & Metal',
    location: 'Storage',
    items: [
      { name: '4.5oz Ceramic Mug', unit: 'Piece' },
      { name: '6oz Tea Glass Cup', unit: 'Piece' },
      { name: '12oz Ceramic Mugs (Latte)', unit: 'Box' },
      { name: '14oz Ceramic Cup (Dine-in)', unit: 'Piece' },
      { name: '16oz Glass Mug (Iced Latte)', unit: 'Piece' },
      { name: '16oz Glass Coke Cup', unit: 'Piece' },
      { name: '20oz Glass Mug', unit: 'Piece' },
      { name: '20oz Glass Coke Cup', unit: 'Piece' },
      { name: 'Small Glass Pot Base', unit: 'Piece' },
      { name: 'Medium Glass Pot', unit: 'Piece' },
      { name: 'Large Glass Pot', unit: 'Piece' },
      { name: 'Glass Coffee/Tea Base', unit: 'Piece' },
      { name: '35oz Metal Coffee Pot', unit: 'Piece' },
      { name: '5 Liter Tea/Coffee Metal Pot', unit: 'Piece' },
      { name: '2 Tbsp Metal Spoon', unit: 'Piece' },
      { name: 'Small Wood Plate', unit: 'Piece' },
      { name: 'Large Wood Plate', unit: 'Piece' }
    ]
  },
  {
    category: 'Warehouse — Packaging & Paper',
    location: 'Storage',
    items: [
      { name: '1 lb Bags', unit: 'Box' },
      { name: '15 lb Bag', unit: 'Piece' },
      { name: '1oz Tin Box', unit: 'Piece' },
      { name: '16oz Tin Box', unit: 'Box' },
      { name: '6" Clear Box', unit: 'Box' },
      { name: '96oz Travel Box', unit: 'Box 50' },
      { name: 'Honeycomb Plastic To-Go Box', unit: 'Box' },
      { name: 'Sandwich To-Go Box', unit: 'Box' },
      { name: 'Small Shopping Bags', unit: 'Box' },
      { name: 'Large Shopping Bags', unit: 'Box' },
      { name: 'Shopping Bags 4.5x10.25', unit: 'Box' },
      { name: 'Napkin', unit: 'Box 5500' },
      { name: 'Jumbo Straws', unit: 'Box' },
      { name: 'Forks', unit: 'Box' },
      { name: 'Knife', unit: 'Box' },
      { name: 'Thermal Paper', unit: 'Roll' },
      { name: 'Shibam Sticker Roll', unit: 'Roll 3333' },
      { name: 'Custom Acrylic Percolator Cover (5 gal)', unit: 'Piece' }
    ]
  },
  {
    category: 'Warehouse — Pantry & Spices',
    location: 'Storage',
    items: [
      { name: 'Almudhesh Evaporated Milk', unit: 'Box' },
      { name: '50 lb Sugar', unit: 'Box' },
      { name: 'Raw Brown Sugar Stick Packets', unit: 'Branded Box 2000' },
      { name: 'Blue Sugar Substitute Stick Packets', unit: 'Branded Box 2000' },
      { name: 'Pink Sugar Substitute Stick Packets', unit: 'Branded Box 2000' },
      { name: 'Shibam Spices', unit: 'lb' },
      { name: 'Cardamom', unit: 'lb' },
      { name: 'Cinnamon', unit: 'lb' },
      { name: 'Cloves', unit: 'lb' },
      { name: 'Ginger Spice', unit: 'lb' },
      { name: '50g Dragon Fruit Diced', unit: 'Bag' },
      { name: 'Lotus Spread Bucket 17.6 lb', unit: 'Bucket' },
      { name: 'Sprite Can', unit: 'Box' }
    ]
  },
  {
    category: 'Warehouse — K-Cups & Merch',
    location: 'Storage',
    items: [
      { name: 'Dark K-Cup 12PC', unit: 'Box' },
      { name: 'Dark K-Cup 24PC', unit: 'Box' },
      { name: 'Medium K-Cup 12PC', unit: 'Box' },
      { name: 'Medium K-Cup 24PC', unit: 'Box' },
      { name: 'Apron', unit: 'Piece' },
      { name: 'Hoodies', unit: 'Piece' }
    ]
  }
];

const DESSERT_ITEMS = [
  'Honeycomb',
  'Sabaya',
  'Pistachio Milk Cake',
  'Lotus Milk Cake',
  'Ras Malai Milk Cake',
  'Rose Milk Cake',
  'Oreo Milk Cake',
  'Caramel Milk Cake',
  'Mango Milk Cake',
  'Kunafa Cheesecake',
  'Lotus Cheesecake',
  'Pistachio Cheesecake',
  'Berry Cheesecake',
  'Tiramisu Cheesecake',
  'Tiramisu',
  'Dubai Chocolate',
  'Dubai Brownie',
  'Dark Chocolate',
  'Matcha Chocolate',
  'Caramel Chocolate',
  'Sticky Toffee Date Cake',
  'Persian Love Cake',
  'Pistachio Tart',
  'Mango Tart',
  'Strawberry Frasier',
  'Cake Pops',
  'Simit — Sesame',
  'Simit — Zaatar',
  'Zaatar Focaccia',
  'Olive Focaccia',
  'Rosemary Focaccia',
  'Croissants'
];

const DESSERT_VENDOR_ORDERS = [
  {
    vendor: 'Amanda',
    items: [
      { name: 'Kunafa Cheesecake', mon: 2, fri: 3 },
      { name: 'Berry Cheesecake', mon: 2, fri: 2 },
      { name: 'Simit', mon: 8, fri: 2 },
      { name: 'Olive Focaccia', mon: 3, fri: 2 },
      { name: 'Rosemary Focaccia', mon: 2, fri: 1 },
      { name: 'Zaatar Focaccia', mon: 3, fri: 3 }
    ]
  },
  {
    vendor: 'Halima',
    items: [
      { name: 'Ras Malai Milk Cake', mon: 3, fri: 3 },
      { name: 'Rose Milk Cake', mon: 2, fri: 3 },
      { name: 'Sticky Toffee Date Cake', mon: 20, fri: 20 }
    ]
  },
  {
    vendor: 'Imaan',
    items: [
      { name: 'Pistachio Milk Cake', mon: 4, fri: 4 },
      { name: 'Lotus Milk Cake', mon: 4, fri: 4 }
    ]
  },
  {
    vendor: 'Jamila',
    items: [
      { name: 'Meat Pie', mon: 0, fri: 0 },
      { name: 'Cheese Pie', mon: 0, fri: 0 },
      { name: 'Spinach Pie', mon: 0, fri: 0 }
    ]
  },
  {
    vendor: 'Mohamed',
    items: [
      { name: 'Honeycomb', mon: 8, fri: 14 }
    ]
  },
  {
    vendor: 'Naserra',
    items: [
      { name: 'Tiramisu Cheesecake', mon: 2, fri: 5 },
      { name: 'Lotus Cheesecake', mon: 3, fri: 3 },
      { name: 'Pistachio Cheesecake', mon: 3, fri: 3 },
      { name: 'Dubai Brownie', mon: 16, fri: 16 },
      { name: 'Pistachio Tart', mon: 24, fri: 24 },
      { name: 'Mango Tart', mon: 24, fri: 24 },
      { name: 'Strawberry Frasier', mon: 0, fri: 0 }
    ]
  },
  {
    vendor: 'Nausheen',
    items: [
      { name: 'Oreo Milk Cake', mon: 3, fri: 3 },
      { name: 'Caramel Milk Cake', mon: 2, fri: 2 },
      { name: 'Cake Pops', mon: 40, fri: 45 }
    ]
  },
  {
    vendor: 'Sami',
    items: [
      { name: 'Sabaya', mon: 3, fri: 3 }
    ]
  },
  {
    vendor: 'Yara',
    items: [
      { name: 'Dubai Chocolate', mon: 100, fri: 0 }
    ]
  }
];

const LOCAL_ORDER_SECTIONS = [
  {
    title: 'Bar & Front of House',
    note: '',
    items: [
      { name: 'Whole Milk', threshold: 6, unit: 'Jug/Bottle', target: 20 },
      { name: '2% Milk', threshold: 1, unit: 'Jug/Bottle', target: 2 },
      { name: 'Half & Half', threshold: 2, unit: 'Jug/Bottle', target: 4 },
      { name: 'Heavy Cream', threshold: 3, unit: 'Jug/Bottle', target: 4 },
      { name: 'Whipped Cream', threshold: 1, unit: 'Jug/Bottle', target: 3 },
      { name: 'Lime', threshold: 0.1, unit: 'Bag', target: 1 },
      { name: 'Mint', threshold: 0.1, unit: 'Bunch', target: 1 },
      { name: 'Honey', threshold: 2, unit: 'Jug/Bottle', target: 5 },
      { name: 'Lemonade', threshold: 2, unit: 'Jug/Bottle', target: 6 },
      { name: 'Mascarpone', threshold: 2, unit: 'Tub', target: null },
      { name: 'Water (Kirkland)', threshold: 0.5, unit: 'Case', target: 1 },
      { name: 'Water (Fiji)', threshold: 0.5, unit: 'Case', target: 1 },
      { name: 'Sprite', threshold: 0.5, unit: 'Case', target: 3 },
      { name: 'Parchment Paper (register)', threshold: 1, unit: 'Box', target: 2 }
    ]
  },
  {
    title: 'Cleaning & Supplies',
    note: '',
    items: [
      { name: 'Large Trash Bags 50+ Gallon', threshold: 2, unit: 'Roll', target: null },
      { name: 'Bathroom Trash Bags 13 Gallon', threshold: 2, unit: 'Roll', target: null },
      { name: 'Paper Towels', threshold: 2, unit: 'Roll', target: null },
      { name: 'Pine Sol', threshold: 2, unit: 'Jug/Bottle', target: null },
      { name: 'Hand Towels', threshold: 1, unit: 'Pack', target: null }
    ]
  },
  {
    title: 'Check Downstairs Storage First',
    note: 'Walk down and look before adding either of these — we often already have them in storage.',
    items: [
      { name: 'Evaporated Milk', threshold: 1, unit: 'Case', target: 4 },
      { name: 'Condensed Milk', threshold: 1, unit: 'Case', target: 4 }
    ]
  }
];
