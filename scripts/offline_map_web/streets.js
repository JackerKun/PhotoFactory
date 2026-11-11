'use strict';

// OpenMapTiles geometry uses a tile-local extent. At deep zooms we render the
// relevant portion of its parent vector tile directly onto a fresh canvas.
function renderStreetTile(bytes, { z, x, y }, nativeZoom) {
  const { VectorTile, Pbf } = StreetVector;
  const layers = new VectorTile(new Pbf(new Uint8Array(bytes))).layers;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f2efe9';
  ctx.fillRect(0, 0, 256, 256);
  ctx.lineJoin = ctx.lineCap = 'round';

  const scale = 2 ** Math.max(0, z - nativeZoom);
  const offsetX = (x % scale) * 256;
  const offsetY = (y % scale) * 256;
  const point = (p, extent) => ({
    x: p.x * 256 * scale / extent - offsetX,
    y: p.y * 256 * scale / extent - offsetY,
  });
  const visible = (p, margin = 0) => p.x >= -margin && p.y >= -margin &&
    p.x < 256 + margin && p.y < 256 + margin;

  function visit(name, callback) {
    const layer = layers[name];
    if (!layer) return;
    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index);
      callback(feature, layer.extent);
    }
  }

  function path(feature, extent) {
    const [left, top, right, bottom] = feature.bbox();
    const a = point({ x: left, y: top }, extent);
    const b = point({ x: right, y: bottom }, extent);
    if (b.x < -8 || b.y < -8 || a.x > 264 || a.y > 264) return false;
    ctx.beginPath();
    for (const part of feature.loadGeometry()) {
      for (let index = 0; index < part.length; index += 1) {
        const p = point(part[index], extent);
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      if (feature.type === 3) ctx.closePath();
    }
    return true;
  }

  function fill(name, color) {
    visit(name, (feature, extent) => {
      if (feature.type !== 3 || !path(feature, extent)) return;
      ctx.fillStyle = typeof color === 'function' ? color(feature.properties.class) : color;
      if (ctx.fillStyle) ctx.fill('evenodd');
    });
  }

  function line(name, color, width, filter = () => true) {
    visit(name, (feature, extent) => {
      if (feature.type !== 2 || !filter(feature.properties) || !path(feature, extent)) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    });
  }

  fill('landcover', (kind) => ({ wood: '#cfdfbd', grass: '#dce9c8', sand: '#eee7ce' })[kind] || '#e6e9d6');
  fill('landuse', (kind) => ({ residential: '#eae5dd', industrial: '#e8dfe9', cemetery: '#d9e5c8' })[kind] || '#e8eadb');
  fill('park', '#d4e8c2');
  fill('water', '#aad3df');
  line('waterway', '#aad3df', z >= 13 ? 2 : 1);
  line('boundary', '#ad99ac', 1, (props) => Number(props.admin_level) <= (z <= 6 ? 4 : 8));
  if (z >= 13) fill('building', '#d5c5b8');

  const roads = [
    { classes: ['path', 'track', 'service'], min: 14, color: '#faf6ef', width: 1.5 },
    { classes: ['minor', 'street', 'residential'], min: 12, color: '#fff', width: 2.5 },
    { classes: ['tertiary', 'secondary'], min: 9, color: '#fff3c8', width: 3.2 },
    { classes: ['primary', 'trunk', 'motorway'], min: 5, color: '#f6c2a9', width: 4 },
  ];
  for (const road of roads) {
    if (z < road.min) continue;
    const filter = (props) => road.classes.includes(props.class);
    const width = z >= 16 ? road.width * 1.7 : z >= 13 ? road.width : Math.max(1, road.width / 2);
    if (z >= 12) line('transportation', '#cbbcb1', width + 1.1, filter);
    line('transportation', road.color, width, filter);
  }

  const labels = [];
  const name = (props) => props['name:zh-Hans'] || props['name:zh'] || props.name || props.name_en;
  function label(text, p, size, color, keepInside = false) {
    if (!text || typeof text !== 'string' || text.length > 60 || !visible(p, 64)) return false;
    ctx.font = `${size}px system-ui, sans-serif`;
    const width = ctx.measureText(text).width;
    const box = [p.x - width / 2 - 2, p.y - size / 2 - 2, p.x + width / 2 + 2, p.y + size / 2 + 2];
    const [left, top, right, bottom] = box;
    if (right <= 0 || bottom <= 0 || left >= 256 || top >= 256) return false;
    if (keepInside && (left < 0 || top < 0 || right > 256 || bottom > 256)) return false;
    if (labels.some(([l, t, r, b]) => left < r && top < b && right > l && bottom > t)) return false;
    labels.push(box);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fffef9';
    ctx.strokeText(text, p.x, p.y);
    ctx.fillStyle = color;
    ctx.fillText(text, p.x, p.y);
    return true;
  }

  visit('place', (feature, extent) => {
    const props = feature.properties;
    if (feature.type !== 1 || (z < 9 && !['country', 'state', 'city', 'town'].includes(props.class))) return;
    const [p] = feature.loadGeometry();
    if (p?.length) label(name(props), point(p[0], extent), 13, '#35434a');
  });
  if (z >= 14) {
    const namedRoads = new Set();
    ctx.font = '11px system-ui, sans-serif';
    visit('transportation_name', (feature, extent) => {
      const text = name(feature.properties);
      if (!text || namedRoads.has(text) || feature.type !== 2) return;
      const margin = ctx.measureText(text).width / 2 + 2;
      let bestLength = 14;
      let anchor;
      for (const segment of feature.loadGeometry()) {
        for (let i = 1; i < segment.length; i += 1) {
          const a = point(segment[i - 1], extent);
          const b = point(segment[i], extent);
          const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const length = Math.hypot(a.x - b.x, a.y - b.y);
          if (length > bestLength && center.x >= margin && center.x <= 256 - margin &&
              center.y >= 8 && center.y <= 248) {
            anchor = center;
            bestLength = length;
          }
        }
      }
      if (anchor && label(text, anchor, 11, '#4c4945', true)) namedRoads.add(text);
    });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法生成街道瓦片')), 'image/png');
  });
}
