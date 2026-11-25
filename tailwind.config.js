/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx,html}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#2563eb", // Clash Verge signature dynamic blue
          600: "#1d4ed8",
          700: "#1e40af",
          800: "#1e3a8a",
          900: "#172554",
        },
        surface: {
          light: "#f2f4f8", // Verge soft canvas gray
          card: "#ffffff",
          dark: "#0e1117",
          darkCard: "#181c26",
          darkCardHover: "#1f2432",
        },
        dark: {
          bg: "#0e1117",
          card: "#181c26",
          cardHover: "#1f2432",
          border: "#282e3f",
          sidebar: "#13161f"
        }
      },
      fontFamily: {
        sans: [
          '"Segoe UI Variable Display"',
          '"Segoe UI Variable Text"',
          '"Segoe UI"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: [
          '"Cascadia Code"',
          '"JetBrains Mono"',
          'Consolas',
          'monospace',
        ],
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '20px',
        '4xl': '24px',
      },
      boxShadow: {
        'card': '0 2px 14px rgba(0, 0, 0, 0.03)',
        'card-hover': '0 6px 20px rgba(0, 0, 0, 0.06)',
        'pill': '0 2px 8px rgba(37, 99, 235, 0.25)',
      }
    },
  },
  plugins: [],
}
