import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        action: "#0066cc",
        focus: "#0071e3",
        sky: "#2997ff",
        canvas: "#ffffff",
        parchment: "#f5f5f7",
        pearl: "#fafafc",
        ink: "#1d1d1f",
        muted: "#7a7a7a",
        hairline: "#e0e0e0",
        tile: {
          1: "#272729",
          2: "#2a2a2c",
          3: "#252527",
        },
      },
      borderRadius: {
        apple: "18px",
      },
      fontFamily: {
        display: [
          "SF Pro Display",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "sans-serif",
        ],
        body: [
          "SF Pro Text",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "sans-serif",
        ],
        code: ["SF Mono", "JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
