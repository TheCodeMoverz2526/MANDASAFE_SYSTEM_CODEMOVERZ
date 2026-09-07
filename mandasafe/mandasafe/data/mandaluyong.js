/* ============================================================
   MandaSafe — Mandaluyong City boundary
   Approximate administrative boundary polygon (WGS84 lon/lat).
   Used to clip / mask the Leaflet map so only Mandaluyong is shown.
   ============================================================ */
const MANDALUYONG_BOUNDARY = {
  "type": "Feature",
  "properties": { "name": "Mandaluyong City", "province": "Metro Manila" },
  "geometry": {
    "type": "Polygon",
    "coordinates": [[
      [121.02450, 14.59050],
      [121.02620, 14.59380],
      [121.02780, 14.59650],
      [121.03150, 14.59900],
      [121.03620, 14.60080],
      [121.04050, 14.60290],
      [121.04480, 14.60640],
      [121.05000, 14.60560],
      [121.05390, 14.60340],
      [121.05680, 14.60000],
      [121.05880, 14.59560],
      [121.06120, 14.59180],
      [121.06400, 14.58720],
      [121.06520, 14.58300],
      [121.06400, 14.57900],
      [121.06180, 14.57520],
      [121.05900, 14.57180],
      [121.05480, 14.56880],
      [121.05000, 14.56600],
      [121.04520, 14.56360],
      [121.04000, 14.56230],
      [121.03520, 14.56380],
      [121.03150, 14.56650],
      [121.02900, 14.57020],
      [121.02680, 14.57420],
      [121.02460, 14.57880],
      [121.02300, 14.58280],
      [121.02250, 14.58680],
      [121.02450, 14.59050]
    ]]
  }
};

/* Bounding box + centre used by every map on the system */
const MANDA_CENTER = [14.5836, 121.0409];
const MANDA_BOUNDS = [[14.5590, 121.0180], [14.6090, 121.0680]];

/* ---------- Barangays (37) ---------- */
const MANDA_BARANGAYS = [
  "Addition Hills","Bagong Silang","Barangka Drive","Barangka Ibaba","Barangka Ilaya",
  "Barangka Itaas","Buayang Bato","Burol","Daang Bakal","Hagdang Bato Itaas",
  "Hagdang Bato Libis","Harapin ang Bukas","Highway Hills","Hulo","Mabini-J. Rizal",
  "Malamig","Mauway","Namayan","New Zañiga","Old Zañiga",
  "Pag-asa","Plainview","Pleasant Hills","Poblacion","San Jose",
  "Vergara","Wack-Wack Greenhills"
];
