/* =========================================================
   MandaSafe — Leaflet map helpers
   Every map is locked to the Mandaluyong City boundary:
   the area outside the city polygon is masked out and the
   view cannot be panned beyond the city bounds.
   ========================================================= */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; OpenStreetMap contributors | MandaSafe – Mandaluyong City TPMO';

/* World ring used to build the "everything except Mandaluyong" mask */
const WORLD_RING = [[-90,-180],[-90,180],[90,180],[90,-180]];

function ringLatLng(){
  return MANDALUYONG_BOUNDARY.geometry.coordinates[0].map(c=>[c[1],c[0]]);
}

function createMandaMap(elId, opts){
  opts = opts || {};
  const map = L.map(elId, {
    center: MANDA_CENTER,
    zoom: opts.zoom || 14,
    minZoom: 13,
    maxZoom: 18,
    zoomControl: opts.zoomControl !== false,
    scrollWheelZoom: opts.scroll !== false,
    attributionControl: true,
    maxBounds: L.latLngBounds(MANDA_BOUNDS).pad(0.12),
    maxBoundsViscosity: 0.95
  });

  L.tileLayer(TILE_URL, {attribution: TILE_ATTR, maxZoom: 19}).addTo(map);

  const ring = ringLatLng();

  /* Mask: dim everything outside the city limits */
  L.polygon([WORLD_RING, ring], {
    stroke:false, fillColor:'#0b2f6d', fillOpacity:0.42, interactive:false
  }).addTo(map);

  /* City outline */
  L.polygon(ring, {
    color:'#1d4ed8', weight:3, opacity:.95, dashArray:'6 4',
    fillColor:'#3b82f6', fillOpacity:0.05, interactive:false
  }).addTo(map).bindTooltip('Mandaluyong City', {permanent:false, sticky:true});

  map.fitBounds(L.latLngBounds(ring), {padding:[12,12]});
  setTimeout(()=>map.invalidateSize(), 250);
  return map;
}

/* Red map pin with a black outline and white hole; the tip sits on the location. */
const PIN_SVG = '<svg viewBox="4.3 1.3 15.4 18.8" width="26" height="32">'+
  '<path d="M12 19.3 6.88 13.77A7 7 0 1 1 17.12 13.77Z" fill="#dc2626" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>'+
  '<circle cx="12" cy="9" r="3.5" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>';
function markerIcon(type, count){
  return L.divIcon({
    className:'',
    html:'<div class="map-pin">'+PIN_SVG+(count>1?'<b>'+count+'</b>':'')+'</div>',
    iconSize:[26,32], iconAnchor:[13,31], popupAnchor:[0,-30]
  });
}

function plotIncidents(map, list){
  const layer = L.layerGroup().addTo(map);
  list.forEach(i=>{
    L.marker([i.lat,i.lng],{icon:markerIcon(i.type,i.count)})
     .addTo(layer)
     .bindPopup(
       '<b>'+i.title+'</b>'+
       '<span>'+i.type+' • '+i.loc+'</span>'+
       '<div style="margin-top:7px"><span class="tag '+(SEVERITY_TAG[i.sev]||'')+'">'+i.sev+'</span> '+
       '<span class="tag '+(STATUS_TAG[i.status]||'')+'">'+i.status+'</span></div>'+
       '<div style="margin-top:6px;font-size:11.5px;color:#64748b">'+i.id+' • '+i.time+'</div>'
     );
  });
  return layer;
}

/* Heat-style visualisation built from stacked translucent circles
   (no plugin needed — keeps the system pure HTML/CSS/JS). Each spot is tinted by its
   risk level from hotspotLevel(): red high, yellow moderate, green low. */
function plotHeat(map, spots){
  const layer = L.layerGroup().addTo(map);
  const rings = [
    {r:520, o:0.10},
    {r:380, o:0.16},
    {r:250, o:0.24},
    {r:150, o:0.34},
    {r: 80, o:0.55}
  ];
  spots.forEach(s=>{
    const level = hotspotLevel(s, spots);
    rings.forEach(g=>{
      L.circle([s.lat,s.lng],{
        radius:g.r*s.w, stroke:false, fillColor:level.color, fillOpacity:g.o*s.w, interactive:false
      }).addTo(layer);
    });
    L.circleMarker([s.lat,s.lng],{radius:6,color:'#fff',weight:2,fillColor:level.color,fillOpacity:1})
      .addTo(layer)
      .bindPopup('<b>'+s.name+'</b><span>'+level.label+' • '+s.count+' incidents</span>');
  });
  return layer;
}
