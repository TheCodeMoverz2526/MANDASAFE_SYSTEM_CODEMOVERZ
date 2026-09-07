# MandaSafe — Road Incident Mapping & Analytics System
Mandaluyong City Traffic Planning and Management Office

Pure HTML / CSS / JavaScript. No build step, no framework.

## Run
Open `index.html` in a browser (or serve the folder with any static server).
Login page accepts any valid email + a password of 6+ characters.
Demo account: `juan.delacruz@gmail.com` / `mandasafe`

## Pages
| File | Description |
|---|---|
| index.html | Public landing page (city hall hero, live map, features, stats band) |
| login.html | User login — city hall photo background |
| dashboard.html | Stats, live incident map, recent incidents, my activity, safety tip |
| report.html | Report an incident — validation, map pin, geolocation, photo preview |
| incident-map.html | Full map with search + type/severity/status filters and result table |
| my-incidents.html | Tabbed list of the user's own reports |
| hotspots.html | Heat visualisation + top hotspot areas ranking |
| safety-index.html | Animated gauge + category bars |
| announcements.html | Official LGU advisories |
| notifications.html | Alerts, mark-all-as-read |
| profile.html | Editable user info, change password, report counters |
| about.html / support.html | Support pages |

## Structure
```
css/style.css          all styling (design tokens at the top)
js/app.js              icons, seed data, localStorage, shell (topbar + sidebar), helpers
js/map.js              Leaflet setup, Mandaluyong mask, markers, heat circles
data/mandaluyong.js    city boundary polygon, bounds, barangay list
assets/                cityhall.png (background), seal.svg
```

## Maps
Leaflet 1.9.4 (CDN) with OpenStreetMap tiles. Every map is locked to Mandaluyong:
the area outside the city polygon is masked, the outline is drawn, and panning is
constrained to the city bounds. The polygon lives in `data/mandaluyong.js` — replace
its coordinates with the official LGU shapefile export when you have it.

## Data
Incidents, the logged-in user and edits are kept in `localStorage`, so submitted
reports persist between pages and reloads. Clear site data to reset to the seed set.
