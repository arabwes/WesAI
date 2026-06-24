# Images

This folder is empty by default. Every `<img>` on the site points at a
filename below and degrades gracefully (the broken image removes itself via
`onerror`, leaving the warm gradient background in place) until you drop in
real photos — so the site is safe to deploy before photography is ready.

Add files using these **exact names** so the existing `<img src>` references
pick them up with no HTML changes:

| File | Used on | Suggested shot | Recommended size |
|---|---|---|---|
| `og-image.jpg` | All pages (Open Graph / Twitter card) | Hero shot of a signature drink or storefront | 1200×630px |
| `hero-storefront.jpg` | Home — hero | Storefront / coffee bar, wide shot | 1920×1080px |
| `hero-menu.jpg` | Menu — hero | Flat lay of drinks and desserts | 1920×1080px |
| `hero-catering.jpg` | Catering & Events — hero | Catering spread / drink station | 1920×1080px |
| `hero-about.jpg` | About — hero | Interior, wide shot | 1920×1080px |
| `hero-location.jpg` | Location — hero | Exterior / storefront sign | 1920×1080px |
| `hero-contact.jpg` | Contact — hero | Counter / register area | 1920×1080px |
| `menu-pistachio-latte.jpg` | Home — Signature Favorites | Pistachio Latte | 800×600px |
| `menu-shibam-latte.jpg` | Home — Signature Favorites | Shibam Latte | 800×600px |
| `menu-adeni-chai.jpg` | Home — Signature Favorites | Adeni Chai | 800×600px |
| `dessert-honeycomb-bread.jpg` | Home — Signature Favorites | Honeycomb Bread | 800×600px |
| `heritage-shibam-city.jpg` | Home — Heritage of Shibam | City of Shibam, Yemen (or an evocative editorial shot) | 1000×800px |
| `app-preview.jpg` | Home — Order Ahead & Rewards | Phone mockup of the ordering app | 1000×800px |
| `about-interior.jpg` | About — Our Story | Interior seating | 1000×800px |
| `about-yemen-coffee.jpg` | About — Yemen: Origin of Coffee | Traditional qahwa service | 1000×800px |
| `about-storefront-exterior.jpg` | About — gallery | Storefront exterior | 800×800px |
| `about-interior-atmosphere.jpg` | About — gallery | Interior atmosphere | 800×800px |
| `about-coffee-bar.jpg` | About — gallery | Coffee bar in action | 800×800px |
| `about-drinks.jpg` | About — gallery | Lineup of drinks | 800×800px |
| `about-community-gathering.jpg` | About — gallery | Guests gathered together | 800×800px |
| `about-desserts.jpg` | About — gallery | Dessert case / plated desserts | 800×800px |

## Guidelines

- **Format:** JPEG for photos, WebP if you want smaller file sizes (update
  the `src` extensions to match if you switch formats).
- **Compression:** Keep hero images under ~300KB and card/grid images under
  ~150KB to protect the PageSpeed score — this site ships with zero
  render-blocking resources, so don't undo that with unoptimized photos.
- **Alt text:** Every `<img>` already has descriptive `alt` text written in
  the HTML. If you swap in a different photo than the suggestion above,
  update the `alt` attribute to match what's actually in the shot.
