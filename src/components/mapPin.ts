import L from "leaflet";

export const MAP_PIN_ICON_URL = "/marker-icon.png";
export const MAP_PIN_RETINA_URL = "/marker-icon-2x.png";
export const MAP_PIN_SHADOW_URL = "/marker-shadow.png";

/** One explicit icon keeps photo, search and GPS-edit markers identical. */
export const mapPinIcon = L.icon({
  iconUrl: MAP_PIN_ICON_URL,
  iconRetinaUrl: MAP_PIN_RETINA_URL,
  shadowUrl: MAP_PIN_SHADOW_URL,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
  shadowAnchor: [12, 41],
});
