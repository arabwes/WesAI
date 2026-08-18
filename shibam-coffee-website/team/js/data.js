// /team/js/data.js
// The dessert vendor standing order (Tab B of Dessert Inventory) is the one
// list still kept static here — its Mon/Fri standing-quantity shape doesn't
// fit the shared Catalog schema the other three lists moved into. Everything
// else (Inventory, Dessert daily count, Local Order List) is now fetched
// live from the Apps Script backend's Catalog sheet — see team/README.md.

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
