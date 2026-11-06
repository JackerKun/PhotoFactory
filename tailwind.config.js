// tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { primary: "#f5f5f7", secondary: "#ffffff", tertiary: "#e8e8ed" },
        accent: { primary: "#007aff", secondary: "#5e5ce6" },
        surface: { primary: "#f2f2f7", secondary: "#d9d9df" },
        text: { primary: "#1d1d1f", secondary: "#6e6e73", muted: "#8e8e93" },
        card: "#ffffff",
      },
      boxShadow: {
        mac: "0 10px 35px rgba(0, 0, 0, 0.10), 0 1px 3px rgba(0, 0, 0, 0.08)",
      },
    },
  },
  plugins: [],
};
