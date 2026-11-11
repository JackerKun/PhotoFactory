// tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    fontSize: { xs: ["0.8125rem", "1.25rem"], sm: ["0.875rem", "1.4rem"], base: ["1rem", "1.5rem"], lg: ["1.125rem", "1.75rem"], xl: ["1.25rem", "1.75rem"], "2xl": ["1.5rem", "2rem"], "3xl": ["1.875rem", "2.25rem"] },
    extend: {
      colors: {
        bg: { primary: "rgb(var(--bg-primary) / <alpha-value>)", secondary: "rgb(var(--bg-secondary) / <alpha-value>)", tertiary: "rgb(var(--bg-tertiary) / <alpha-value>)" },
        accent: { link: "rgb(var(--accent-link) / <alpha-value>)", primary: "rgb(var(--accent-primary) / <alpha-value>)", secondary: "#7774ed" },
        surface: { primary: "rgb(var(--surface-primary) / <alpha-value>)", secondary: "rgb(var(--surface-secondary) / <alpha-value>)" },
        text: { primary: "rgb(var(--text-primary) / <alpha-value>)", secondary: "rgb(var(--text-secondary) / <alpha-value>)", muted: "rgb(var(--text-muted) / <alpha-value>)" },
        card: "rgb(var(--bg-secondary) / <alpha-value>)",
        gray: Object.fromEntries([50,100,200,300,400,500,600,700,800,900,950].map((n) => [n, `rgb(var(--gray-${n}) / <alpha-value>)`])),
      },
      boxShadow: {
        mac: "0 10px 35px rgba(0, 0, 0, 0.10), 0 1px 3px rgba(0, 0, 0, 0.08)",
      },
    },
  },
  plugins: [],
};
