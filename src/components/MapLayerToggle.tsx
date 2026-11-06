import React from "react";
import type { MapLayerStyle } from "../api/tauri";

export default React.memo(function MapLayerToggle({ value, onChange }: {
  value: MapLayerStyle;
  onChange: (value: MapLayerStyle) => void;
}) {
  return (
    <div className="absolute right-3 top-3 z-[1000] flex rounded-lg border border-black/10 bg-white/95 p-0.5 shadow-md backdrop-blur">
      <button
        type="button"
        aria-label="标准地图"
        title="标准地图"
        onClick={() => onChange("standard")}
        className={`h-8 rounded-md px-2.5 text-sm transition-colors ${value === "standard" ? "bg-accent-primary text-white shadow-sm" : "text-gray-600 hover:bg-black/5"}`}
      >
        🗺️
      </button>
      <button
        type="button"
        aria-label="卫星实景地图"
        title="卫星实景地图"
        onClick={() => onChange("satellite")}
        className={`h-8 rounded-md px-2.5 text-sm transition-colors ${value === "satellite" ? "bg-accent-primary text-white shadow-sm" : "text-gray-600 hover:bg-black/5"}`}
      >
        ◉
      </button>
    </div>
  );
});
