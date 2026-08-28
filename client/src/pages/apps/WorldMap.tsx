import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapContainer, GeoJSON, Marker } from 'react-leaflet';
import L from 'leaflet';
import type { Feature, FeatureCollection, GeoJsonObject, Geometry } from 'geojson';
import type { PathOptions } from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface CityPoint { lat: number; lon: number; count: number; city: string; country: string; countryCode: string; }

// ip-api.com country name → Natural Earth 110m name for choropleth matching
const COUNTRY_NAME_MAP: Record<string, string> = {
  'United States':                    'United States of America',
  'Czech Republic':                   'Czechia',
  'Bosnia and Herzegovina':           'Bosnia and Herz.',
  'Central African Republic':         'Central African Rep.',
  'Democratic Republic of the Congo': 'Dem. Rep. Congo',
  'Dominican Republic':               'Dominican Rep.',
  'Ivory Coast':                      "Cote d'Ivoire",
  'South Korea':                      'South Korea',
  'North Korea':                      'North Korea',
  'Republic of the Congo':            'Congo',
  'Tanzania':                         'United Rep. of Tanzania',
  'Syria':                            'Syrian Arab Republic',
  'Laos':                             'Lao PDR',
  'Moldova':                          'Republic of Moldova',
  'North Macedonia':                  'North Macedonia',
  'Palestine':                        'Palestine',
  'Vatican City':                     'Vatican',
  'Eswatini':                         'eSwatini',
  'Myanmar':                          'Myanmar',
  'Venezuela':                        'Venezuela',
  'Bolivia':                          'Bolivia',
  'Russia':                           'Russia',
  'Iran':                             'Iran',
  'Vietnam':                          'Vietnam',
  'Taiwan':                           'Taiwan',
};

// Convert ISO 3166-1 alpha-2 code to flag emoji (Unicode regional indicators)
function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '';
  const base = 0x1F1E6 - 0x41; // A.charCodeAt(0) = 65
  return String.fromCodePoint(base + code.toUpperCase().charCodeAt(0), base + code.toUpperCase().charCodeAt(1));
}

// Shift negative longitudes of antimeridian-crossing rings to keep polygons continuous.
// Leaflet draws a horizontal line across the whole map for any ring that has coordinates
// on both sides of the +/-180 meridian (Russia, Fiji). Adding 360 to negative coords
// places the ring in the 180-210 range -- still correct on the repeating mercator tile.
function fixRing(ring: number[][]): number[][] {
  const hasEast = ring.some(c => c[0] > 90);
  const hasWest = ring.some(c => c[0] < -90);
  if (!hasEast || !hasWest) return ring;
  return ring.map(([lon, lat, ...r]) => [lon < 0 ? lon + 360 : lon, lat, ...r]);
}

function fixGeom(g: Geometry): Geometry {
  if (g.type === 'Polygon')      return { ...g, coordinates: g.coordinates.map(fixRing) };
  if (g.type === 'MultiPolygon') return { ...g, coordinates: g.coordinates.map(p => p.map(fixRing)) };
  return g;
}

let worldCache: GeoJsonObject | null = null;
async function loadWorld(): Promise<GeoJsonObject> {
  if (worldCache) return worldCache;
  const res  = await fetch('/world.geojson');
  const raw  = await res.json() as FeatureCollection;
  const features: Feature[] = raw.features
    .filter(f => {
      const g = f.geometry;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return true;
      const flat = g.type === 'Polygon' ? g.coordinates.flat() : g.coordinates.flat(2);
      return flat.some(c => c[1] > -55); // drop Antarctica
    })
    .map(f => f.geometry ? { ...f, geometry: fixGeom(f.geometry) } : f);
  worldCache = { type: 'FeatureCollection', features } as GeoJsonObject;
  return worldCache;
}

function choroplethColor(count: number, maxCount: number, isDark: boolean): string {
  if (count === 0) return isDark ? '#1f2937' : '#d1d5db';
  const t = Math.pow(count / maxCount, 0.4);
  if (isDark) {
    const r = Math.round(0x14 + t * (0x4a - 0x14));
    const g = Math.round(0x53 + t * (0xde - 0x53));
    const b = Math.round(0x2d + t * (0x80 - 0x2d));
    return `rgb(${r},${g},${b})`;
  } else {
    const r = Math.round(0x16 + t * (0x86 - 0x16));
    const g = Math.round(0x65 + t * (0xef - 0x65));
    const b = Math.round(0x34 + t * (0xac - 0x34));
    return `rgb(${r},${g},${b})`;
  }
}

// No data: 50% opaque; fewer requests: 70% opaque; more requests: 90% opaque
function choroplethOpacity(count: number, maxCount: number): number {
  if (count === 0) return 0.5;
  return 0.7 + Math.pow(count / maxCount, 0.4) * 0.2;
}

const LS_ZORDER_KEY = 'btp-worldmap-zorder';

interface Props {
  cities:         CityPoint[];
  isDark?:        boolean;
  selectedCity?:  string;
  onCityClick?:   (cityKey: string) => void;
}

export default function WorldMap({ cities, isDark, selectedCity, onCityClick }: Props) {
  const [world, setWorld] = useState<GeoJsonObject | null>(null);

  // Persist click-to-front ordering across refreshes via localStorage.
  // Array is front-first: index 0 = highest z-index.
  const [cityZOrder, setCityZOrder] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(LS_ZORDER_KEY);
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch { return []; }
  });

  const handleCityClick = useCallback((key: string) => {
    setCityZOrder(prev => {
      const next = [key, ...prev.filter(k => k !== key)];
      try { localStorage.setItem(LS_ZORDER_KEY, JSON.stringify(next)); } catch { /* storage full / private mode */ }
      return next;
    });
    onCityClick?.(key);
  }, [onCityClick]);

  useEffect(() => { void loadWorld().then(setWorld); }, []);

  const countByNEName = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cities) {
      const neName = COUNTRY_NAME_MAP[c.country] ?? c.country;
      m.set(neName, (m.get(neName) ?? 0) + c.count);
    }
    return m;
  }, [cities]);

  const countryMaxCount = useMemo(() => {
    let max = 1;
    countByNEName.forEach(v => { if (v > max) max = v; });
    return max;
  }, [countByNEName]);

  const countryStyle = (feature?: Feature): PathOptions => {
    const name  = (feature?.properties as Record<string, string> | undefined)?.['name'] ?? '';
    const count = countByNEName.get(name) ?? 0;
    return {
      fillColor:   choroplethColor(count, countryMaxCount, isDark ?? false),
      fillOpacity: choroplethOpacity(count, countryMaxCount),
      color:       isDark ? '#374151' : '#9ca3af',
      weight:      0.5,
    };
  };

  // Key includes selectedCity so label highlight re-renders when selection changes
  const geoJsonKey = useMemo(
    () => cities.map(c => `${c.lat},${c.lon},${c.count}`).join('|') + (isDark ? 'd' : 'l'),
    [cities, isDark],
  );

  return (
    <div className="relative w-full rounded-lg overflow-hidden" style={{ aspectRatio: '2/1' }}>
      <MapContainer
        center={[25, 10]}
        zoom={1.5}
        minZoom={1}
        maxZoom={6}
        style={{ height: '100%', width: '100%', background: 'transparent' }}
        attributionControl={false}
        zoomControl={false}
      >
        {world && (
          <GeoJSON
            key={geoJsonKey}
            data={world}
            style={countryStyle}
          />
        )}

        {cities.map((city, i) => {
          const flag      = countryFlag(city.countryCode);
          const key       = `${city.countryCode}-${city.city}`;
          const active    = selectedCity === key;
          const clickable = !!onCityClick;
          const bg        = active ? 'rgba(16,185,129,0.9)' : 'rgba(0,0,0,0.72)';
          const outline   = active ? '2px solid #10b981' : 'none';
          const ptrEvt    = clickable ? 'auto' : 'none';
          const cursor    = clickable ? 'pointer' : 'default';
          const reqColor  = active ? '#fff' : '#86efac';

          // z-index: front-of-stack = highest offset; unranked markers sit at 0
          const zOrderIdx   = cityZOrder.indexOf(key);
          const zOffset     = zOrderIdx === -1 ? 0 : (cityZOrder.length - zOrderIdx) * 10;

          const icon = L.divIcon({
            className: '',
            iconSize:   [0, 0],
            iconAnchor: [0, 0],
            html: [
              `<div style="position:absolute;transform:translate(-50%,-50%);`,
              `background:${bg};outline:${outline};color:#fff;`,
              `font-size:10px;line-height:1.45;padding:2px 6px;border-radius:3px;`,
              `white-space:nowrap;pointer-events:${ptrEvt};cursor:${cursor};`,
              `display:flex;flex-direction:column;align-items:center;">`,
              `<span>${flag ? flag + ' ' : ''}${city.city}</span>`,
              `<span style="color:${reqColor}">Req: ${city.count.toLocaleString()}</span>`,
              `</div>`,
            ].join(''),
          });

          return (
            <Marker
              key={`${key}-${i}-${active ? 'a' : 'i'}`}
              position={[city.lat, city.lon]}
              icon={icon}
              interactive={clickable}
              zIndexOffset={zOffset}
              eventHandlers={clickable ? { click: () => handleCityClick(key) } : undefined}
            />
          );
        })}
      </MapContainer>
    </div>
  );
}
