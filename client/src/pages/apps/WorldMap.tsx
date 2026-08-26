import { useEffect, useRef, useState } from 'react';

// Simplified continent/landmass outlines as [lon, lat][] polygons (equirectangular)
const LAND: [number, number][][] = [
  // North America
  [[-168,71],[-141,61],[-130,54],[-125,49],[-125,38],[-117,32],[-97,26],
   [-84,10],[-82,9],[-78,8],[-90,15],[-98,20],[-108,23],[-118,29],
   [-126,35],[-126,49],[-138,59],[-153,60],[-166,68],[-168,71]],
  // Greenland
  [[-25,75],[-18,78],[-20,84],[-44,85],[-62,82],[-74,76],[-25,75]],
  // South America
  [[-80,10],[-62,12],[-50,2],[-35,-5],[-35,-12],[-40,-30],[-52,-52],
   [-70,-52],[-74,-44],[-72,-34],[-65,-22],[-76,-10],[-80,2],[-80,10]],
  // Europe (simplified, blended with western Russia)
  [[-12,36],[5,36],[15,38],[28,38],[35,43],[40,48],[38,55],[30,68],
   [18,72],[5,62],[-5,58],[-8,50],[-10,44],[-5,36],[-12,36]],
  // Scandinavia
  [[5,58],[8,62],[12,66],[18,70],[28,70],[22,60],[18,56],[10,56],[5,58]],
  // British Isles
  [[-8,50],[2,50],[2,52],[0,54],[-5,56],[-8,56],[-8,50]],
  // Africa
  [[-18,37],[38,37],[42,12],[52,11],[44,2],[42,-5],[35,-28],[20,-35],
   [18,-35],[10,-20],[8,-5],[0,5],[-5,5],[-16,8],[-18,15],[-18,37]],
  // Madagascar
  [[44,-12],[50,-15],[50,-25],[44,-25],[44,-12]],
  // Eurasia main (including SE Asia peninsula)
  [[28,38],[38,38],[42,12],[52,12],[62,22],[68,22],[78,26],[80,28],
   [90,24],[95,22],[100,10],[104,1],[106,5],[110,22],[116,24],[120,25],
   [130,35],[130,42],[142,46],[148,52],[168,55],[175,64],[170,72],
   [145,72],[100,72],[60,72],[38,65],[28,62],[28,38]],
  // Indian subcontinent
  [[68,24],[80,28],[80,22],[76,8],[72,8],[68,24]],
  // Japan (simplified)
  [[130,31],[132,32],[135,34],[140,38],[142,44],[140,42],[136,35],[130,31]],
  // Taiwan
  [[120,22],[122,22],[122,25],[120,25],[120,22]],
  // Sumatra
  [[95,5],[105,-2],[108,-5],[106,-6],[95,-5],[95,5]],
  // Borneo
  [[108,4],[118,7],[118,0],[108,-4],[108,4]],
  // Java
  [[106,-6],[112,-8],[115,-8],[114,-7],[106,-6]],
  // Australia
  [[115,-22],[130,-15],[148,-18],[152,-25],[152,-34],[148,-40],
   [138,-38],[128,-35],[115,-35],[113,-25],[115,-22]],
  // New Zealand (N Island)
  [[174,-37],[178,-37],[178,-40],[174,-41],[174,-37]],
  // New Zealand (S Island)
  [[168,-44],[172,-44],[172,-46],[170,-47],[168,-46],[168,-44]],
  // Antarctica
  [[-180,-68],[0,-70],[180,-68],[180,-90],[-180,-90],[-180,-68]],
];

const W = 1200;
const H = 600;
const lonToX = (lon: number) => ((lon + 180) / 360) * W;
const latToY = (lat: number) => ((90 - lat) / 180) * H;

export interface CityPoint { lat: number; lon: number; count: number; city: string; }

export default function WorldMap({ cities, isDark }: { cities: CityPoint[]; isDark?: boolean }) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; city: string; count: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx    = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Background
    ctx.fillStyle = isDark ? '#0c1424' : '#dbeafe';
    ctx.fillRect(0, 0, W, H);

    // Graticule (every 30°)
    ctx.strokeStyle = isDark ? '#1e3a5f' : '#bfdbfe';
    ctx.lineWidth   = 0.5;
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = lonToX(lon);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let lat = -90; lat <= 90; lat += 30) {
      const y = latToY(lat);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Land polygons
    ctx.fillStyle   = isDark ? '#1e3d6e' : '#93c5fd';
    ctx.strokeStyle = isDark ? '#2563ab' : '#60a5fa';
    ctx.lineWidth   = 0.8;
    for (const poly of LAND) {
      if (poly.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(lonToX(poly[0]![0]), latToY(poly[0]![1]));
      for (let i = 1; i < poly.length; i++) ctx.lineTo(lonToX(poly[i]![0]), latToY(poly[i]![1]));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // City dots
    if (cities.length > 0) {
      const maxCount = Math.max(...cities.map(c => c.count));
      for (const city of cities) {
        const x = lonToX(city.lon);
        const y = latToY(city.lat);
        const r = 3 + (Math.log(city.count + 1) / Math.log(maxCount + 1)) * 14;

        // Glow
        const grd = ctx.createRadialGradient(x, y, 0, x, y, r * 2.5);
        grd.addColorStop(0, 'rgba(251,146,60,0.35)');
        grd.addColorStop(1, 'rgba(251,146,60,0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(x, y, r * 2.5, 0, Math.PI * 2); ctx.fill();

        // Core dot
        ctx.fillStyle = '#f97316';
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }, [cities, isDark]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || cities.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const mx   = (e.clientX - rect.left) * (W / rect.width);
    const my   = (e.clientY - rect.top)  * (H / rect.height);
    const max  = Math.max(...cities.map(c => c.count));
    for (const city of cities) {
      const cx = lonToX(city.lon);
      const cy = latToY(city.lat);
      const r  = 3 + (Math.log(city.count + 1) / Math.log(max + 1)) * 14;
      if (Math.hypot(mx - cx, my - cy) <= r + 4) {
        setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, city: city.city, count: city.count });
        return;
      }
    }
    setTooltip(null);
  };

  return (
    <div className="relative w-full rounded-lg overflow-hidden" style={{ aspectRatio: '2/1' }}>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="w-full h-full"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
      />
      {tooltip && (
        <div
          className="absolute pointer-events-none bg-popover border border-border rounded px-2 py-1 text-xs shadow-md whitespace-nowrap"
          style={{ left: tooltip.x + 10, top: tooltip.y - 24 }}
        >
          <span className="font-medium">{tooltip.city}</span>
          <span className="text-muted-foreground ml-1">· {tooltip.count} req</span>
        </div>
      )}
    </div>
  );
}
