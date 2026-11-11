import Icon from "./Icon";
import React from "react";
import type { MapLayerStyle } from "../api/tauri";

export default React.memo(function MapLayerToggle({ value, onChange, children }: {
  value: MapLayerStyle;
  onChange: (value: MapLayerStyle) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="absolute right-3 top-3 z-[1000] flex rounded-lg border border-text-primary/10 bg-bg-secondary/95 p-0.5 shadow-md backdrop-blur">
      <button
        type="button"
        aria-label="标准地图"
        title="标准地图"
        onClick={() => onChange("standard")}
        className={`h-8 rounded-md px-2.5 text-sm transition-colors ${value === "standard" ? "bg-accent-primary text-white shadow-sm" : "text-gray-600 hover:bg-text-primary/5"}`}
      >
        <Icon name="map" size={18} />
      </button>
      <button
        type="button"
        aria-label="卫星实景地图"
        title="卫星实景地图"
        onClick={() => onChange("satellite")}
        className={`h-8 rounded-md px-2.5 text-sm transition-colors ${value === "satellite" ? "bg-accent-primary text-white shadow-sm" : "text-gray-600 hover:bg-text-primary/5"}`}
      >
        <Icon name="satellite" size={18} />
      </button>
      {children}
    </div>
  );
});
