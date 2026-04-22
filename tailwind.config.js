/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        cove: {
          bg: "rgb(var(--cove-bg) / <alpha-value>)",
          surface: "rgb(var(--cove-surface) / <alpha-value>)",
          border: "rgb(var(--cove-border) / <alpha-value>)",
          text: "rgb(var(--cove-text) / <alpha-value>)",
          muted: "rgb(var(--cove-muted) / <alpha-value>)",
          accent: "rgb(var(--cove-accent) / <alpha-value>)",
          success: "rgb(var(--cove-success) / <alpha-value>)",
          danger: "rgb(var(--cove-danger) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
