import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "../api/tauri";
import type { MapLayerStyle } from "../api/tauri";
import L from "leaflet";

// Deduplicate in-flight tile requests
const pendingTiles = new Map<string, Promise<string>>();
const MAX_MEMORY_TILES = 512;

function getTileKey(layer: MapLayerStyle, z: number, x: number, y: number) {
  return `${layer}/${z}/${x}/${y}`;
}

// Fetch tile: check cache -> download -> return local URL
async function fetchTile(layer: MapLayerStyle, z: number, x: number, y: number): Promise<string> {
  const key = getTileKey(layer, z, x, y);
  if (pendingTiles.has(key)) return pendingTiles.get(key)!;

  const promise = (async () => {
    try {
      const filePath = await api.getMapTile(z, x, y, layer);
      return convertFileSrc(filePath);
    } catch (err) {
      console.warn(`Backend tile fetch failed for ${key}, falling back to OSM:`, err);
      return layer === "satellite"
        ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
        : `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    } finally {
      pendingTiles.delete(key);
    }
  })();

  pendingTiles.set(key, promise);
  return promise;
}

// Memory cache of resolved URLs
const urlCache = new Map<string, string>();

function rememberUrl(key: string, url: string) {
  // Map insertion order gives us a cheap LRU. Refresh hits and keep the cache bounded.
  if (urlCache.has(key)) urlCache.delete(key);
  urlCache.set(key, url);
  while (urlCache.size > MAX_MEMORY_TILES) {
    const oldest = urlCache.keys().next().value;
    if (oldest === undefined) break;
    urlCache.delete(oldest);
  }
}

// Custom GridLayer that fetches tiles through our cache backend
const CachedTileLayerClass = L.GridLayer.extend({
  createTile(coords: L.Coords, done: L.DoneCallback) {
    const tile = document.createElement("div");
    const layer = (this.options as L.GridLayerOptions & { photoFactoryLayer?: MapLayerStyle }).photoFactoryLayer ?? "standard";
    const key = getTileKey(layer, coords.z, coords.x, coords.y);

    // Set tile dimensions
    const size = this.getTileSize();
    tile.style.width = `${size.x}px`;
    tile.style.height = `${size.y}px`;

    // Check memory cache first
    if (urlCache.has(key)) {
      const cachedUrl = urlCache.get(key)!;
      rememberUrl(key, cachedUrl);
      const img = document.createElement("img");
      img.style.width = `${size.x}px`;
      img.style.height = `${size.y}px`;
      img.style.display = "block";
      img.onload = () => done(undefined, tile);
      img.onerror = () => done(undefined, tile);
      img.src = cachedUrl;
      tile.appendChild(img);
      return tile;
    }

    // Show placeholder while loading
    tile.style.backgroundColor = "#ddd";

    // Fetch tile URL asynchronously
    fetchTile(layer, coords.z, coords.x, coords.y).then((url) => {
      rememberUrl(key, url);
      const img = document.createElement("img");
      img.style.width = `${size.x}px`;
      img.style.height = `${size.y}px`;
      img.style.display = "block";
      img.onload = () => {
        tile.style.backgroundColor = "";
        done(undefined, tile);
      };
      img.onerror = () => {
        console.warn(`Tile image load failed: ${key} -> ${url}`);
        done(undefined, tile);
      };
      img.src = url;
      tile.appendChild(img);
    }).catch((err) => {
      console.error(`Error fetching tile ${key}:`, err);
      done(undefined, tile);
    });

    return tile;
  },
}) as new (options?: L.GridLayerOptions) => L.GridLayer;

export default function CachedTileLayerComponent({ layer = "standard" }: { layer?: MapLayerStyle }) {
  const map = useMap();
  const layerRef = useRef<L.GridLayer | null>(null);

  useEffect(() => {
    const tileLayer = new CachedTileLayerClass({
      maxZoom: 19,
      attribution: layer === "satellite"
        ? "Tiles &copy; Esri"
        : "&copy; OpenStreetMap contributors",
      photoFactoryLayer: layer,
    } as L.GridLayerOptions);
    tileLayer.addTo(map);
    layerRef.current = tileLayer;

    return () => {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
    };
  }, [map, layer]);

  return null;
}
